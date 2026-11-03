'use strict';

/**
 * Tests de la ENCUESTA SEMANAL ("¿Cómo estuvo tu resumen de hoy?"):
 *   - feedbackSnapshot.js   validación del cuerpo y resumen de las notas que el usuario tenía en el digest
 *   - la ruta               POST /users/:userId/feedback con la autenticación real y Mongo falso
 * Correr:  npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

process.env.JWT_SECRET = 'x'.repeat(48);

const SRC = path.join(__dirname, '..', '..');
const USER_ID = '65f1a2b3c4d5e6f708192a3b';
const OTRO_USER_ID = '65f1a2b3c4d5e6f708192a3c';
const ARTICLE_ID = '65f1a2b3c4d5e6f708190011';

const { parseFeedbackBody, snapshotFromRun } = require('../../utils/feedbackSnapshot');

const item = (extra = {}) => ({
  topic: 'River Plate',
  articleId: ARTICLE_ID,
  url: 'https://medio.test/river',
  matchZone: 'AMARILLA',
  tier: 'buena',
  ageHoursAtPick: 22.8,
  usedFallback: false,
  ...extra,
});

const corrida = (items, extra = {}) => ({
  deliveryDate: '2026-11-03',
  digest: { user: { id: USER_ID }, digest: { items } },
  ...extra,
});

// ================================================================ validación

test('encuesta: acepta las tres caras, con y sin comentario', () => {
  for (const rating of [1, 2, 3]) {
    assert.deepEqual(parseFeedbackBody({ rating }), { ok: true, rating, comment: '' });
  }
  assert.deepEqual(parseFeedbackBody({ rating: '2', comment: '  más   notas de tenis  ' }), {
    ok: true, rating: 2, comment: 'más notas de tenis',
  });
  assert.deepEqual(parseFeedbackBody({ rating: 3, comment: null }), { ok: true, rating: 3, comment: '' });
});

test('encuesta: rechaza una cara inválida o un comentario raro', () => {
  for (const rating of [0, 4, -1, 'muy bien', null, undefined, 2.5]) {
    assert.equal(parseFeedbackBody({ rating }).code, 'INVALID_RATING', `rating: ${rating}`);
  }
  assert.equal(parseFeedbackBody({ rating: 2, comment: { texto: 'x' } }).code, 'INVALID_COMMENT');
  assert.equal(parseFeedbackBody({ rating: 2, comment: 'a'.repeat(501) }).code, 'COMMENT_TOO_LONG');
  assert.equal(parseFeedbackBody({ rating: 2, comment: 'a'.repeat(500) }).ok, true);
  assert.equal(parseFeedbackBody(undefined).code, 'INVALID_RATING');
});

// ================================================================ lo que estaba mirando

test('encuesta: resume las notas del digest con la decisión del motor', () => {
  const snap = snapshotFromRun(corrida([item(), item({ topic: 'Tenis', matchZone: 'RESCATE', tier: 'sugerida', usedFallback: true, ageHoursAtPick: 3.1 })]));
  assert.equal(snap.deliveryDate, '2026-11-03');
  assert.deepEqual(snap.notas, [
    { articleId: ARTICLE_ID, topic: 'River Plate', zona: 'AMARILLA', nivel: 'buena', edadHoras: 22.8, usedFallback: false },
    { articleId: ARTICLE_ID, topic: 'Tenis', zona: 'RESCATE', nivel: 'sugerida', edadHoras: 3.1, usedFallback: true },
  ]);
});

test('encuesta: sin corrida o con datos rotos no explota', () => {
  assert.deepEqual(snapshotFromRun(null), { deliveryDate: null, notas: [] });
  assert.deepEqual(snapshotFromRun({ digest: { items: 'no es lista' } }), { deliveryDate: null, notas: [] });
  const [nota] = snapshotFromRun(corrida([{ articleId: 'no-es-un-id', ageHoursAtPick: 'x' }])).notas;
  assert.equal(nota.articleId, null, 'un id inválido no rompe el guardado');
  assert.equal(nota.edadHoras, null);
  assert.equal(nota.usedFallback, null);
});

// ================================================================ la ruta

function consulta(valor, { falla = false } = {}) {
  const resultado = () => (falla ? Promise.reject(new Error('Mongo caído')) : Promise.resolve(valor));
  const chain = {
    select() { return chain; },
    sort() { return chain; },
    limit() { return chain; },
    lean() { return resultado(); },
    then(res, rej) { return resultado().then(res, rej); },
  };
  return chain;
}

function instalarStub(relPath, exports) {
  const abs = require.resolve(path.join(SRC, relPath));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports, children: [], paths: [] };
}

const silenciar = () => {
  const originales = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  return () => Object.assign(console, originales);
};

function montarRutas({ run = corrida([item()]), fallaCorrida = false, fallaGuardado = false } = {}) {
  const registro = { guardados: [] };
  const usuario = { _id: USER_ID, name: 'Naty', isActive: true, deliveryTime: '09:00', topics: ['River Plate', 'Tenis', 'Milei'] };

  instalarStub('models/UserPreference.js', { findById: (id) => consulta(String(id) === USER_ID ? usuario : null) });
  instalarStub('models/UserDeliveryRun.js', {
    find: () => consulta([]),
    findOne: () => consulta(run, { falla: fallaCorrida }),
    findOneAndUpdate: () => consulta({}),
    updateOne: async () => ({ matchedCount: 1 }),
    deleteMany: async () => {},
  });
  instalarStub('models/Article.js', { findById: () => consulta(null) });
  instalarStub('models/UserShownArticle.js', { find: () => consulta([]), deleteMany: async () => {} });
  instalarStub('models/DigestTestLog.js', { create: async () => {}, deleteMany: async () => {} });
  instalarStub('utils/buildDigestForUser.js', { buildDigestForUser: async () => ({}) });
  instalarStub('utils/saveShownArticlesForUser.js', { saveShownArticlesForUser: async () => {} });
  instalarStub('audio/generateDigestAudioFile.js', { generateDigestAudioFile: async () => {} });
  instalarStub('audio/uploadDigestAudio.js', { uploadDigestAudio: async () => ({ audioUrl: null }) });
  instalarStub('audio/getStaticConnectors.js', { getStaticConnectors: async () => [] });
  instalarStub('models/UserFeedback.js', Object.assign(
    {
      findOneAndUpdate: async (filtro, update, opciones) => {
        registro.guardados.push({ filtro, update, opciones });
        if (fallaGuardado) throw new Error('Mongo caído');
        return {};
      },
      deleteMany: async () => {},
    },
    { FEEDBACK_RATINGS: [1, 2, 3], FEEDBACK_COMMENT_MAX: 500 }
  ));

  delete require.cache[require.resolve(path.join(SRC, 'routes', 'userRoutes.js'))];
  const router = require(path.join(SRC, 'routes', 'userRoutes.js'));
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/users', router);

  const { signUserToken } = require(path.join(SRC, 'middleware', 'auth.js'));
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const pedir = async (ruta, body, token = signUserToken(USER_ID)) => {
        const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
        const r = await fetch(base + ruta, { method: 'POST', headers, body: JSON.stringify(body) });
        return { status: r.status, body: await r.json() };
      };
      resolve({ registro, pedir, cerrar: () => new Promise((ok) => server.close(ok)) });
    });
  });
}

const ENCUESTA = `/users/${USER_ID}/feedback`;

test('POST encuesta: guarda la cara, el comentario y lo que estaba mirando', async () => {
  const restaurar = silenciar();
  const t = await montarRutas();
  try {
    const r = await t.pedir(ENCUESTA, { rating: 1, comment: 'Me llegó una nota de Boca para River' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });

    const [{ filtro, update, opciones }] = t.registro.guardados;
    assert.equal(String(filtro.userId), USER_ID);
    assert.match(filtro.responseDate, /^\d{4}-\d{2}-\d{2}$/, 'una respuesta por día');
    assert.equal(opciones.upsert, true, 'responder de nuevo el mismo día la cambia');
    assert.equal(update.$set.rating, 1);
    assert.equal(update.$set.comment, 'Me llegó una nota de Boca para River');
    assert.deepEqual(update.$set.topics, ['River Plate', 'Tenis', 'Milei']);
    assert.equal(update.$set.deliveryDate, '2026-11-03');
    assert.equal(update.$set.notas[0].zona, 'AMARILLA');
  } finally {
    await t.cerrar();
    restaurar();
  }
});

test('POST encuesta: el cliente no puede inventar las notas ni las fechas', async () => {
  const restaurar = silenciar();
  const t = await montarRutas();
  try {
    await t.pedir(ENCUESTA, { rating: 3, notas: [{ zona: 'FALSA' }], deliveryDate: '1999-01-01', responseDate: '1999-01-01', userId: OTRO_USER_ID });
    const [{ filtro, update }] = t.registro.guardados;
    assert.equal(String(filtro.userId), USER_ID);
    assert.notEqual(filtro.responseDate, '1999-01-01');
    assert.equal(update.$set.deliveryDate, '2026-11-03');
    assert.equal(update.$set.notas[0].zona, 'AMARILLA');
  } finally {
    await t.cerrar();
    restaurar();
  }
});

test('POST encuesta: si falla leer la corrida, la respuesta se guarda igual sin notas', async () => {
  const restaurar = silenciar();
  const t = await montarRutas({ fallaCorrida: true });
  try {
    const r = await t.pedir(ENCUESTA, { rating: 2 });
    assert.equal(r.status, 200);
    assert.deepEqual(t.registro.guardados[0].update.$set.notas, []);
  } finally {
    await t.cerrar();
    restaurar();
  }
});

test('POST encuesta: rechaza una cara inválida sin guardar nada', async () => {
  const restaurar = silenciar();
  const t = await montarRutas();
  try {
    const r = await t.pedir(ENCUESTA, { rating: 7 });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'INVALID_RATING');
    assert.equal(t.registro.guardados.length, 0);
  } finally {
    await t.cerrar();
    restaurar();
  }
});

test('POST encuesta: si falla el guardado contesta 500 y no miente', async () => {
  const restaurar = silenciar();
  const t = await montarRutas({ fallaGuardado: true });
  try {
    const r = await t.pedir(ENCUESTA, { rating: 2 });
    assert.equal(r.status, 500);
    assert.equal(r.body.code, 'SAVE_FEEDBACK_FAILED');
  } finally {
    await t.cerrar();
    restaurar();
  }
});

test('POST encuesta: sin token, o en nombre de otro usuario, no se puede', async () => {
  const restaurar = silenciar();
  const t = await montarRutas();
  try {
    assert.equal((await t.pedir(ENCUESTA, { rating: 2 }, null)).status, 401);
    assert.equal((await t.pedir(`/users/${OTRO_USER_ID}/feedback`, { rating: 2 })).status, 403);
    assert.equal(t.registro.guardados.length, 0);
  } finally {
    await t.cerrar();
    restaurar();
  }
});
