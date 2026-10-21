'use strict';

/**
 * Tests de las RUTAS de userRoutes.js que entregan un digest ya guardado: GET /:userId/digest y POST /:userId/digest/play.
 * Se levanta el router real de Express con la autenticación real (JWT) y todo lo demás falso: modelos de Mongo,
 * audio y el armado del digest. Comprueban que ninguna nota con más de 24 h llega al usuario y que lo
 * reemplazado se guarda en el mismo run sin tocar preparedAt.
 * Correr:  npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

process.env.JWT_SECRET = 'x'.repeat(48);

const SRC = path.join(__dirname, '..', '..');
const USER_ID = '65f1a2b3c4d5e6f708192a3b';

// ---------------------------------------------------------------- escenario falso
const hace = (horas) => new Date(Date.now() - horas * 3600e3);
let seq = 0;
const item = (topic, horas, extra = {}) => ({
  topic,
  articleId: `65f1a2b3c4d5e6f7081900${String(seq).padStart(2, '0')}`,
  url: `https://medio.test/${seq++}`,
  title: `Nota de ${topic}`,
  neutralTitle: `Nota de ${topic}`,
  neutralSummary: 'resumen',
  publishedAt: hace(horas),
  category: 'Deportes',
  ...extra,
});
const nested = (items) => ({
  user: { id: USER_ID, name: 'Lucas', topics: ['Fútbol', 'Economía', 'river plate'] },
  digest: { items, audioUrl: null, audioStorageKey: null, audioGeneratedAt: null },
});

const consulta = (valor) => ({
  sort() { return this; },
  lean() { return Promise.resolve(valor); },
  then(res, rej) { return Promise.resolve(valor).then(res, rej); },
});

function instalarStub(relPath, exports) {
  const abs = require.resolve(path.join(SRC, relPath));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports, children: [], paths: [] };
}

/**
 * Carga una copia nueva del router con todo lo de afuera falso.
 * @param {{hoy?:object, ultimo?:object, rearmar?:Function}} esc
 */
function montar(esc = {}) {
  const registro = { updateOne: [], rearmados: [], articulosPedidos: [], audiosGenerados: 0, saveShown: [] };

  const usuario = {
    _id: USER_ID, name: 'Lucas', isActive: true, deliveryTime: '08:00', topics: ['Fútbol', 'Economía', 'river plate'],
    greetingAudioUrl: 'https://audio.test/saludo.mp3', greetingNameUsed: 'Lucas', save: async () => {},
  };

  instalarStub('models/UserPreference.js', { findById: (id) => consulta(String(id) === USER_ID ? usuario : null) });
  instalarStub('models/UserDeliveryRun.js', {
    findOne: (filtro) => consulta(filtro.deliveryDate ? (esc.hoy || null) : (esc.ultimo || null)),
    updateOne: async (filtro, update) => { registro.updateOne.push({ filtro, update }); return { matchedCount: 1 }; },
    findOneAndUpdate: () => consulta({}),
  });
  instalarStub('models/UserShownArticle.js', { find: () => consulta([]), deleteMany: async () => {} });
  instalarStub('models/DigestTestLog.js', { create: async () => {}, deleteMany: async () => {} });
  instalarStub('models/Article.js', {
    findById: (id) => {
      registro.articulosPedidos.push(String(id));
      return consulta({ _id: id, audioUrl: `https://audio.test/${id}.mp3`, save: async () => {} });
    },
  });
  instalarStub('audio/generateDigestAudioFile.js', { generateDigestAudioFile: async () => { registro.audiosGenerados++; } });
  instalarStub('audio/uploadDigestAudio.js', { uploadDigestAudio: async () => ({ audioUrl: 'https://audio.test/nuevo.mp3' }) });
  instalarStub('audio/getStaticConnectors.js', { getStaticConnectors: async () => ['https://audio.test/c1.mp3', 'https://audio.test/c2.mp3', 'https://audio.test/c3.mp3'] });
  instalarStub('utils/saveShownArticlesForUser.js', { saveShownArticlesForUser: async (...args) => { registro.saveShown.push(args); } });
  instalarStub('utils/buildDigestForUser.js', {
    buildDigestForUser: async (userId, opciones) => {
      registro.rearmados.push({ userId: String(userId), opciones });
      if (!esc.rearmar) return nested([]);
      return esc.rearmar(opciones);
    },
  });

  const rutas = path.join(SRC, 'routes', 'userRoutes.js');
  delete require.cache[require.resolve(rutas)];
  const router = require(rutas);

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/users', router);

  const { signUserToken } = require(path.join(SRC, 'middleware', 'auth.js'));
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const headers = { Authorization: `Bearer ${signUserToken(USER_ID)}`, 'Content-Type': 'application/json' };
      resolve({
        registro,
        get: async (ruta) => { const r = await fetch(base + ruta, { headers }); return { status: r.status, body: await r.json() }; },
        post: async (ruta, body = {}) => { const r = await fetch(base + ruta, { method: 'POST', headers, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; },
        cerrar: () => new Promise((ok) => server.close(ok)),
      });
    });
  });
}

const corrida = (preparedAt, digest, extra = {}) => ({
  _id: '65f1a2b3c4d5e6f7081900aa', userId: USER_ID, status: 'prepared', preparedAt, digest, ...extra,
});

const silenciar = () => {
  const originales = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  return () => Object.assign(console, originales);
};

const urlsDe = (digest) => (digest.digest?.items || digest.items || []).map((i) => i.url);

// ================================================================ GET /:userId/digest

test('GET digest (hoy): todo vigente se entrega tal cual, sin tocar el motor ni la base', async () => {
  const restaurar = silenciar();
  const guardado = nested([item('Fútbol', 3), item('Economía', 12), item('river plate', 23)]);
  const t = await montar({ hoy: corrida(hace(1), guardado) });
  try {
    const r = await t.get(`/users/${USER_ID}/digest`);
    assert.equal(r.status, 200);
    assert.deepEqual(urlsDe(r.body), urlsDe(guardado));
    assert.equal(t.registro.rearmados.length, 0);
    assert.equal(t.registro.updateOne.length, 0);
  } finally { await t.cerrar(); restaurar(); }
});

test('GET digest (hoy): la nota que se venció esperando se reemplaza en su lugar y se guarda sin tocar preparedAt', async () => {
  const restaurar = silenciar();
  const a = item('Fútbol', 3);
  const vencida = item('Economía', 25);
  const c = item('river plate', 20);
  const repo = item('Economía', 2, { title: 'Reposición' });
  const preparedAt = hace(10);
  const t = await montar({ hoy: corrida(preparedAt, nested([a, vencida, c])), rearmar: async () => nested([repo]) });
  try {
    const r = await t.get(`/users/${USER_ID}/digest`);
    assert.equal(r.status, 200);
    assert.deepEqual(urlsDe(r.body), [a.url, repo.url, c.url], 'misma posición');
    assert.ok(!urlsDe(r.body).includes(vencida.url));

    assert.equal(t.registro.rearmados.length, 1);
    assert.equal(t.registro.rearmados[0].userId, USER_ID);
    assert.deepEqual(t.registro.rearmados[0].opciones.onlyTopics, ['Economía']);
    assert.deepEqual(t.registro.rearmados[0].opciones.keepItems.map((i) => i.url), [a.url, c.url]);

    assert.equal(t.registro.updateOne.length, 1);
    const { filtro, update } = t.registro.updateOne[0];
    assert.equal(filtro._id, '65f1a2b3c4d5e6f7081900aa');
    assert.equal(new Date(filtro.preparedAt).getTime(), preparedAt.getTime(), 'solo si nadie lo rearmó mientras tanto');
    assert.deepEqual(Object.keys(update.$set), ['digest'], 'no se toca preparedAt ni el estado');
    assert.deepEqual(urlsDe(update.$set.digest), [a.url, repo.url, c.url]);
  } finally { await t.cerrar(); restaurar(); }
});

test('GET digest (hoy): si el motor falla se entrega sin las vencidas y NO se guarda', async () => {
  const restaurar = silenciar();
  const a = item('Fútbol', 3);
  const vencida = item('Economía', 30);
  const t = await montar({ hoy: corrida(hace(10), nested([a, vencida])), rearmar: async () => { throw new Error('OpenAI caído'); } });
  try {
    const r = await t.get(`/users/${USER_ID}/digest`);
    assert.equal(r.status, 200, 'la apertura no se rompe');
    assert.deepEqual(urlsDe(r.body), [a.url]);
    assert.equal(t.registro.updateOne.length, 0);
  } finally { await t.cerrar(); restaurar(); }
});

test('GET digest (hoy): sin reposición disponible la nota vencida se saca', async () => {
  const restaurar = silenciar();
  const a = item('Fútbol', 3);
  const t = await montar({ hoy: corrida(hace(10), nested([a, item('Economía', 30), item('river plate', 31)])), rearmar: async () => nested([]) });
  try {
    const r = await t.get(`/users/${USER_ID}/digest`);
    assert.deepEqual(urlsDe(r.body), [a.url]);
    assert.equal(t.registro.updateOne.length, 1, 'el hueco queda guardado: no se reintenta en cada apertura');
  } finally { await t.cerrar(); restaurar(); }
});

test('GET digest (hoy): un digest con la forma vieja ({ items }) también se revisa', async () => {
  const restaurar = silenciar();
  const a = item('Fútbol', 3);
  const repo = item('Economía', 1);
  const t = await montar({ hoy: corrida(hace(10), { items: [a, item('Economía', 40)] }), rearmar: async () => ({ items: [repo] }) });
  try {
    const r = await t.get(`/users/${USER_ID}/digest`);
    assert.deepEqual(urlsDe(r.body), [a.url, repo.url]);
    assert.equal(r.body.digest, undefined);
  } finally { await t.cerrar(); restaurar(); }
});

test('GET digest (otro día, todo vencido): se repone y NO se dispara el refresco en segundo plano', async () => {
  const restaurar = silenciar();
  const ayer = nested([item('Fútbol', 30), item('Economía', 31), item('river plate', 32)]);
  const repos = [item('Fútbol', 2), item('Economía', 3), item('river plate', 4)];
  const t = await montar({ ultimo: corrida(hace(30), ayer), rearmar: async () => nested(repos) });
  try {
    const r = await t.get(`/users/${USER_ID}/digest`);
    assert.deepEqual(urlsDe(r.body), repos.map((i) => i.url));
    assert.deepEqual(t.registro.rearmados[0].opciones.onlyTopics, ['Fútbol', 'Economía', 'river plate']);
    await new Promise((ok) => setImmediate(ok));
    assert.equal(t.registro.rearmados.length, 1, 'solo la reposición: el armado completo espera a la próxima apertura');
  } finally { await t.cerrar(); restaurar(); }
});

test('GET digest (otro día, todo vigente): se entrega y se refresca en segundo plano como antes', async () => {
  const restaurar = silenciar();
  const vigente = nested([item('Fútbol', 5), item('Economía', 6), item('river plate', 7)]);
  const t = await montar({ ultimo: corrida(hace(60), vigente), rearmar: async () => nested([]) });
  try {
    const r = await t.get(`/users/${USER_ID}/digest`);
    assert.deepEqual(urlsDe(r.body), urlsDe(vigente));
    await new Promise((ok) => setTimeout(ok, 20));
    assert.equal(t.registro.rearmados.length, 1);
    assert.deepEqual(
      t.registro.rearmados[0].opciones,
      { background: true },
      'armado completo, en segundo plano: los jueces con IA pueden esperar más porque nadie mira la pantalla'
    );
  } finally { await t.cerrar(); restaurar(); }
});

// ================================================================ POST /:userId/digest/play

test('POST play: reproduce las notas ya revisadas (la vencida se reemplaza antes de armar el audio)', async () => {
  const restaurar = silenciar();
  const a = item('Fútbol', 3);
  const vencida = item('Economía', 27);
  const c = item('river plate', 20);
  const repo = item('Economía', 2);
  const t = await montar({ hoy: corrida(hace(10), nested([a, vencida, c])), rearmar: async () => nested([repo]) });
  try {
    const r = await t.post(`/users/${USER_ID}/digest/play`);
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.deepEqual(t.registro.articulosPedidos.sort(), [a.articleId, repo.articleId, c.articleId].sort());
    assert.ok(!t.registro.articulosPedidos.includes(vencida.articleId), 'el audio de la vencida no se arma');
    // saludo + (conector + nota) x 3
    assert.equal(r.body.playlist.length, 7);
  } finally { await t.cerrar(); restaurar(); }
});

test('POST play: si todas las notas estaban vencidas y no hay reposición, responde que no hay notas', async () => {
  const restaurar = silenciar();
  const t = await montar({ hoy: corrida(hace(10), nested([item('Fútbol', 30)])), rearmar: async () => nested([]) });
  try {
    const r = await t.post(`/users/${USER_ID}/digest/play`);
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'NO_DIGEST_ITEMS');
  } finally { await t.cerrar(); restaurar(); }
});

test('POST play: todo vigente no toca el motor', async () => {
  const restaurar = silenciar();
  const t = await montar({ hoy: corrida(hace(3), nested([item('Fútbol', 3), item('Economía', 4)])) });
  try {
    const r = await t.post(`/users/${USER_ID}/digest/play`);
    assert.equal(r.status, 200);
    assert.equal(t.registro.rearmados.length, 0);
    assert.equal(t.registro.updateOne.length, 0);
  } finally { await t.cerrar(); restaurar(); }
});

// ================================================================ mark-shown

test('POST mark-shown: sigue guardando lo que manda la app', async () => {
  const restaurar = silenciar();
  const t = await montar({});
  try {
    const items = [item('Fútbol', 1)];
    const r = await t.post(`/users/${USER_ID}/digest/mark-shown`, { items, shownDate: '2026-10-15' });
    assert.equal(r.status, 200);
    assert.equal(t.registro.saveShown.length, 1);
    assert.equal(t.registro.saveShown[0][2].shownDate, '2026-10-15');
  } finally { await t.cerrar(); restaurar(); }
});
