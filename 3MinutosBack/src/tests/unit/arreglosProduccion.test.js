'use strict';

/**
 * Tests de cuatro arreglos que salieron de los logs de producción:
 *   - limpieza de audios     importaba mal el cliente de Cloudinary y nunca corría; ahora pagina y limpia audioUrl
 *   - notificaciones         las corridas sin push posible se marcan salteadas (antes ocupaban la cola para siempre)
 *   - ingesta                el temporizador se cancela al terminar (antes logueaba un TIMEOUT falso cada hora)
 *   - token de sesión        se renueva solo, así no vence a los 180 días y el usuario no pierde la cuenta
 * Correr:  npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'x'.repeat(48);

const {
  cleanupOldDigestAudios, selectOldResources, articleIdFromPublicId,
} = require('../../audio/cleanupOldDigestAudios');
const { skipReasonFor, isDeadTokenTicket } = require('../../sendPreparedDigestNotificationsJob');
const { runScript } = require('../../ingestionJob');
const {
  authRequired, shouldRefreshToken, signUserToken, REFRESHED_TOKEN_HEADER, TOKEN_REFRESH_AFTER_DAYS,
} = require('../../middleware/auth');

const HOUR = 3600e3;
const NOW = Date.parse('2026-10-28T12:00:00Z');
const ID_A = '6adf4134f31d616a11976520';
const ID_B = '6adf4108f31d616a119764d6';

// ---------------------------------------------------------------- limpieza de audios

test('audios: el id de la nota sale del public_id', () => {
  assert.equal(articleIdFromPublicId(`articles-chunks/audio-${ID_A}`), ID_A);
  assert.equal(articleIdFromPublicId('greetings/user-123'), null);
  assert.equal(articleIdFromPublicId(''), null);
});

test('audios: solo se eligen los de más de 72 h', () => {
  const files = [
    { public_id: 'a', created_at: new Date(NOW - 73 * HOUR).toISOString() },
    { public_id: 'b', created_at: new Date(NOW - 71 * HOUR).toISOString() },
    { public_id: 'c', created_at: 'no es fecha' },
  ];
  assert.deepEqual(selectOldResources(files, { now: NOW }).map((f) => f.public_id), ['a']);
});

test('audios: recorre todas las páginas, borra los viejos y le saca el audioUrl a la nota', async () => {
  const pages = [
    {
      resources: [
        { public_id: `articles-chunks/audio-${ID_A}`, created_at: new Date(NOW - 100 * HOUR).toISOString() },
        { public_id: 'articles-chunks/audio-nueva', created_at: new Date(NOW - 1 * HOUR).toISOString() },
      ],
      next_cursor: 'pagina-2',
    },
    { resources: [{ public_id: `articles-chunks/audio-${ID_B}`, created_at: new Date(NOW - 80 * HOUR).toISOString() }] },
  ];
  const cursors = [];
  const destroyed = [];
  const updated = [];
  const fakeCloudinary = {
    api: { resources: async (opts) => { cursors.push(opts.next_cursor || null); return pages.shift(); } },
    uploader: { destroy: async (id) => { destroyed.push(id); } },
  };
  const fakeArticle = { updateOne: async (filter, update) => { updated.push([filter._id, update.$set.audioUrl]); } };

  const stats = await cleanupOldDigestAudios({ now: NOW, deps: { cloudinary: fakeCloudinary, Article: fakeArticle } });

  assert.deepEqual(cursors, [null, 'pagina-2']);
  assert.deepEqual(destroyed, [`articles-chunks/audio-${ID_A}`, `articles-chunks/audio-${ID_B}`]);
  assert.deepEqual(updated, [[ID_A, null], [ID_B, null]]);
  assert.deepEqual(stats, { revisados: 3, borrados: 2, errores: 0 });
});

test('audios: el cliente real de Cloudinary se importa bien (antes llegaba undefined)', () => {
  const cloudinary = require('../../config/cloudinary');
  assert.equal(typeof cloudinary.api?.resources, 'function');
  assert.equal(typeof cloudinary.uploader?.destroy, 'function');
});

// ---------------------------------------------------------------- notificaciones

test('notificaciones: motivo para saltear una corrida', () => {
  const ok = { isActive: true, expoPushToken: 'ExponentPushToken[abc123]' };
  assert.equal(skipReasonFor(ok), null);
  assert.equal(skipReasonFor(null), 'usuario_inexistente');
  assert.equal(skipReasonFor({ ...ok, isActive: false }), 'usuario_inactivo');
  assert.equal(skipReasonFor({ ...ok, expoPushToken: null }), 'sin_push_token');
  assert.equal(skipReasonFor({ ...ok, expoPushToken: 'cualquier-cosa' }), 'push_token_invalido');
});

test('notificaciones: un ticket DeviceNotRegistered marca el token como muerto', () => {
  assert.equal(isDeadTokenTicket({ status: 'error', details: { error: 'DeviceNotRegistered' } }), true);
  assert.equal(isDeadTokenTicket({ status: 'error', details: { error: 'MessageRateExceeded' } }), false);
  assert.equal(isDeadTokenTicket({ status: 'ok', id: 'x' }), false);
});

// ---------------------------------------------------------------- ingesta

test('ingesta: un proceso que termina bien no deja un TIMEOUT pendiente', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingesta-'));
  const script = path.join(dir, 'ok.js');
  fs.writeFileSync(script, 'process.exit(0)');

  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await runScript(script, 'prueba', { timeoutMs: 1500 });
    await new Promise((r) => setTimeout(r, 1800)); // más que el tiempo límite
  } finally {
    console.log = original;
  }
  assert.equal(logs.some((l) => l.includes('TIMEOUT')), false);
});

test('ingesta: un proceso colgado se mata y la promesa falla una sola vez', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingesta-'));
  const script = path.join(dir, 'colgado.js');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000)');

  const original = console.log;
  console.log = () => {};
  try {
    await assert.rejects(runScript(script, 'colgado', { timeoutMs: 300 }), /excedió el tiempo límite/);
  } finally {
    console.log = original;
  }
});

// ---------------------------------------------------------------- token de sesión

function fakeRes() {
  return {
    headers: {}, statusCode: 200, body: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function reqWith(token) {
  return { get: (name) => (name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined) };
}

test('token: se renueva pasados los días de gracia, no antes', () => {
  const now = Date.now();
  const iat = Math.floor(now / 1000);
  assert.equal(shouldRefreshToken({ iat }, { now }), false);
  assert.equal(shouldRefreshToken({ iat: iat - (TOKEN_REFRESH_AFTER_DAYS - 1) * 86400 }, { now }), false);
  assert.equal(shouldRefreshToken({ iat: iat - TOKEN_REFRESH_AFTER_DAYS * 86400 }, { now }), true);
  assert.equal(shouldRefreshToken({}, { now }), true);
});

test('token: un token recién emitido pasa sin header nuevo', () => {
  const res = fakeRes();
  let nextCalled = false;
  authRequired(reqWith(signUserToken(ID_A)), res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.headers[REFRESHED_TOKEN_HEADER], undefined);
});

test('token: uno viejo pasa y devuelve otro válido por 180 días más, del mismo usuario', () => {
  const now = Math.floor(Date.now() / 1000);
  const old = jwt.sign(
    { sub: ID_A, type: 'user', iat: now - 170 * 86400 },
    process.env.JWT_SECRET,
    { expiresIn: '180d' }
  );
  const req = reqWith(old);
  const res = fakeRes();
  let nextCalled = false;
  authRequired(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(req.auth.userId, ID_A);
  const fresh = res.headers[REFRESHED_TOKEN_HEADER];
  assert.ok(fresh, 'debería devolver un token nuevo');
  const payload = jwt.verify(fresh, process.env.JWT_SECRET);
  assert.equal(payload.sub, ID_A);
  assert.equal(payload.type, 'user');
  assert.ok(payload.exp - now > 179 * 86400);
});

test('token: uno vencido sigue rechazándose (401) y no se renueva', () => {
  const now = Math.floor(Date.now() / 1000);
  const expired = jwt.sign({ sub: ID_A, type: 'user', iat: now - 200 * 86400, exp: now - 20 * 86400 }, process.env.JWT_SECRET);
  const res = fakeRes();
  let nextCalled = false;
  authRequired(reqWith(expired), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers[REFRESHED_TOKEN_HEADER], undefined);
});
