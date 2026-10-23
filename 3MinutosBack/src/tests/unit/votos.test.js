'use strict';

/**
 * Tests del VOTO de una nota (pulgar arriba / abajo):
 *   - digestItems.js   la forma del digest guardado (anidado o plano) se resuelve en un solo lugar
 *   - voteContext.js   el contexto de la decisión del motor se saca de la corrida que guardó el servidor
 *   - las rutas        POST/DELETE/GET de /users/:userId/digest/vote con la autenticación real
 *
 * Mongo es falso. Lo que se comprueba, además de que guarde: que el cliente NO pueda poner el contexto, que
 * votar de nuevo cambie el voto en vez de sumar otro, y que un voto sin contexto se guarde igual.
 * Correr:  npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

process.env.JWT_SECRET = 'x'.repeat(48);

const SRC = path.join(__dirname, '..', '..');
const USER_ID = '65f1a2b3c4d5e6f708192a3b';
const ARTICLE_ID = '65f1a2b3c4d5e6f708190011';
const OTRO_ARTICLE_ID = '65f1a2b3c4d5e6f708190022';

const { itemsOfStoredDigest, findItemByArticleId } = require('../../utils/digestItems');

// ---------------------------------------------------------------- escenario falso
const hace = (horas) => new Date(Date.now() - horas * 3600e3);

/** Una nota del digest tal como la guarda buildUserNewsDigest. */
const item = (extra = {}) => ({
  topic: 'Dólar y Mercados',
  articleId: ARTICLE_ID,
  url: 'https://medio.test/dolar',
  title: 'El dólar oficial llegó a máximos del mes',
  neutralTitle: 'El dólar oficial llegó a máximos del mes',
  publishedAt: hace(5.1),
  category: 'Economía',
  matchZone: 'ETIQUETA',
  matchScore: null,
  matchReason: 'ETIQUETA buena 5.1h imp=75 puntaje=80.9 (candidato #1 de 35 elegibles)',
  corralCategory: 'Economía',
  candidatesEvaluated: 1,
  tier: 'buena',
  ageHoursAtPick: 5.1,
  usedFallback: false,
  ...extra,
});

const anidado = (items) => ({
  user: { id: USER_ID, name: 'Lucas', topics: ['Dólar y Mercados'] },
  digest: { items, audioUrl: null },
});

/** Cadena de consulta de mongoose: soporta select/sort/limit/lean en cualquier orden. */
function consulta(valor) {
  const chain = {
    select() { return chain; },
    sort() { return chain; },
    limit() { return chain; },
    lean() { return Promise.resolve(valor); },
    then(res, rej) { return Promise.resolve(valor).then(res, rej); },
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

// ================================================================ digestItems.js

test('itemsOfStoredDigest: encuentra las notas en las dos formas en que se guarda un digest', () => {
  const uno = item();
  assert.deepEqual(itemsOfStoredDigest(anidado([uno])), [uno], 'forma anidada { digest: { items } }');
  assert.deepEqual(itemsOfStoredDigest({ items: [uno] }), [uno], 'forma plana { items }');
});

test('itemsOfStoredDigest: sin notas devuelve lista vacía y nunca explota', () => {
  for (const entrada of [null, undefined, {}, 'texto', 42, { digest: {} }, { digest: { items: 'no es lista' } }]) {
    assert.deepEqual(itemsOfStoredDigest(entrada), [], `entrada: ${JSON.stringify(entrada)}`);
  }
});

test('findItemByArticleId: compara como texto (en Mongo el id es un ObjectId, no un string)', () => {
  const uno = item();
  const guardado = anidado([item({ articleId: OTRO_ARTICLE_ID, url: 'https://medio.test/otra' }), uno]);
  assert.equal(findItemByArticleId(guardado, ARTICLE_ID)?.url, uno.url);
  assert.equal(findItemByArticleId(guardado, { toString: () => ARTICLE_ID })?.url, uno.url, 'acepta un ObjectId');
  assert.equal(findItemByArticleId(guardado, '65f1a2b3c4d5e6f708199999'), null, 'una nota que no está');
  assert.equal(findItemByArticleId(guardado, ''), null, 'sin id');
});

// ================================================================ voteContext.js

/** Carga una copia nueva de voteContext con los modelos falsos. */
function montarContexto({ runs = [], importancia = undefined, falla = false } = {}) {
  const pedidos = { runs: 0, articulos: [] };

  instalarStub('models/UserDeliveryRun.js', {
    find: (filtro) => {
      pedidos.runs++;
      pedidos.filtroRuns = filtro;
      if (falla) {
        const chain = { select: () => chain, sort: () => chain, limit: () => chain, lean: () => Promise.reject(new Error('Mongo caído')) };
        return chain;
      }
      return consulta(runs);
    },
  });
  instalarStub('models/Article.js', {
    findById: (id) => {
      pedidos.articulos.push(String(id));
      return consulta(importancia === undefined ? null : { _id: id, importanceScore: importancia });
    },
  });

  const archivo = require.resolve(path.join(SRC, 'utils', 'voteContext.js'));
  delete require.cache[archivo];
  return { ...require(archivo), pedidos };
}

const corrida = (digest, extra = {}) => ({
  _id: '65f1a2b3c4d5e6f7081900aa', userId: USER_ID, deliveryDate: '2026-10-23', digest, ...extra,
});

test('findVoteContext: saca el contexto de la decisión de la corrida guardada', async () => {
  const { findVoteContext } = montarContexto({ runs: [corrida(anidado([item()]))] });
  const ctx = await findVoteContext(USER_ID, ARTICLE_ID);

  assert.equal(ctx.contextSource, 'corrida');
  assert.equal(ctx.topic, 'Dólar y Mercados');
  assert.equal(ctx.zona, 'ETIQUETA');
  assert.equal(ctx.nivel, 'buena');
  assert.equal(ctx.edadHoras, 5.1);
  assert.equal(ctx.importancia, 75, 'del motivo del match cuando la nota ya no está');
  assert.equal(ctx.puntaje, 80.9);
  assert.equal(ctx.candidatosEvaluados, 1);
  assert.equal(ctx.usedFallback, false);
  assert.equal(ctx.deliveryDate, '2026-10-23');
  assert.equal(ctx.articleUrl, 'https://medio.test/dolar');
});

test('findVoteContext: la importancia de la nota manda sobre la del motivo del match', async () => {
  const { findVoteContext } = montarContexto({ runs: [corrida(anidado([item()]))], importancia: 85 });
  const ctx = await findVoteContext(USER_ID, ARTICLE_ID);
  assert.equal(ctx.importancia, 85);
});

test('findVoteContext: un rescate queda marcado como tal', async () => {
  const rescate = item({ matchZone: 'RESCATE', tier: 'sugerida', usedFallback: true, matchReason: 'ningun_candidato_valido' });
  const { findVoteContext } = montarContexto({ runs: [corrida(anidado([rescate]))] });
  const ctx = await findVoteContext(USER_ID, ARTICLE_ID);

  assert.equal(ctx.zona, 'RESCATE');
  assert.equal(ctx.nivel, 'sugerida');
  assert.equal(ctx.usedFallback, true);
  assert.equal(ctx.importancia, null, 'el motivo del rescate no trae imp=');
  assert.equal(ctx.puntaje, null);
});

test('findVoteContext: busca en varias corridas, no solo en la última', async () => {
  const { findVoteContext } = montarContexto({
    runs: [
      corrida(anidado([item({ articleId: OTRO_ARTICLE_ID })]), { deliveryDate: '2026-10-23' }),
      corrida(anidado([item()]), { deliveryDate: '2026-10-22' }),
    ],
  });
  const ctx = await findVoteContext(USER_ID, ARTICLE_ID);
  assert.equal(ctx.contextSource, 'corrida');
  assert.equal(ctx.deliveryDate, '2026-10-22', 'la corrida donde realmente salió la nota');
});

test('findVoteContext: una nota que ya no está en ninguna corrida da contexto vacío, no error', async () => {
  const { findVoteContext, EMPTY_CONTEXT } = montarContexto({ runs: [corrida(anidado([item({ articleId: OTRO_ARTICLE_ID })]))] });
  const ctx = await findVoteContext(USER_ID, ARTICLE_ID);
  assert.deepEqual(ctx, EMPTY_CONTEXT);
  assert.equal(ctx.contextSource, 'sin_contexto');
});

test('findVoteContext: si la lectura de Mongo falla, el contexto queda vacío (el voto se tiene que poder guardar)', async () => {
  const { findVoteContext } = montarContexto({ falla: true });
  const ctx = await findVoteContext(USER_ID, ARTICLE_ID);
  assert.equal(ctx.contextSource, 'sin_contexto');
});

test('findVoteContext: sin usuario o sin nota no consulta nada', async () => {
  const m = montarContexto({ runs: [corrida(anidado([item()]))] });
  assert.equal((await m.findVoteContext(null, ARTICLE_ID)).contextSource, 'sin_contexto');
  assert.equal((await m.findVoteContext(USER_ID, null)).contextSource, 'sin_contexto');
  assert.equal(m.pedidos.runs, 0);
});

test('findVoteContext: un dato que falta queda en null, nunca en 0 (Number(null) es 0 y arruinaría el análisis)', async () => {
  const incompleto = {
    topic: 'Tenis',
    articleId: ARTICLE_ID,
    url: null,
    matchReason: 'ningun_candidato_valido',
    // sin edadHoras, sin candidatesEvaluated, sin usedFallback, sin publishedAt
  };
  const { findVoteContext } = montarContexto({ runs: [corrida(anidado([incompleto]))] });
  const ctx = await findVoteContext(USER_ID, ARTICLE_ID);

  assert.equal(ctx.contextSource, 'corrida');
  for (const campo of ['edadHoras', 'importancia', 'puntaje', 'candidatosEvaluados']) {
    assert.equal(ctx[campo], null, `${campo} tiene que ser null, no 0`);
  }
  assert.equal(ctx.usedFallback, null, 'no se sabe si fue rescate, y eso no es "false"');
  assert.equal(ctx.publishedAt, null);
});

test('desdeMotivo: lee los números del motivo del match y tolera lo que no está', () => {
  const { desdeMotivo } = montarContexto();
  const motivo = 'ETIQUETA buena 5.1h imp=75 puntaje=80.9 (candidato #1 de 35 elegibles)';
  assert.equal(desdeMotivo(motivo, 'imp'), 75);
  assert.equal(desdeMotivo(motivo, 'puntaje'), 80.9);
  assert.equal(desdeMotivo('ningun_candidato_valido', 'imp'), null);
  assert.equal(desdeMotivo(null, 'imp'), null);
  assert.equal(desdeMotivo('VERDE score=0.812 (candidato #1)', 'puntaje'), null, 'el score de búsqueda no es el puntaje');
});

// ================================================================ las rutas

/** Levanta el router real con la autenticación real y Mongo falso. */
function montarRutas({ runs = [], votos = [], fallaGuardado = false } = {}) {
  const registro = { guardados: [], borrados: [], consultados: [] };

  const usuario = { _id: USER_ID, name: 'Lucas', isActive: true, deliveryTime: '08:00', topics: ['Dólar y Mercados'] };

  instalarStub('models/UserPreference.js', { findById: (id) => consulta(String(id) === USER_ID ? usuario : null) });
  instalarStub('models/UserDeliveryRun.js', {
    find: () => consulta(runs),
    findOne: () => consulta(null),
    findOneAndUpdate: () => consulta({}),
    updateOne: async () => ({ matchedCount: 1 }),
    deleteMany: async () => {},
  });
  instalarStub('models/Article.js', { findById: (id) => consulta({ _id: id, importanceScore: 75 }) });
  instalarStub('models/UserShownArticle.js', { find: () => consulta([]), deleteMany: async () => {} });
  instalarStub('models/DigestTestLog.js', { create: async () => {}, deleteMany: async () => {} });

  // Corta la cadena que llega a OpenAI, Cloudinary y Google: el voto no usa nada de eso (igual que rutasDigest.test.js).
  instalarStub('utils/buildDigestForUser.js', { buildDigestForUser: async () => anidado([]) });
  instalarStub('utils/saveShownArticlesForUser.js', { saveShownArticlesForUser: async () => {} });
  instalarStub('audio/generateDigestAudioFile.js', { generateDigestAudioFile: async () => {} });
  instalarStub('audio/uploadDigestAudio.js', { uploadDigestAudio: async () => ({ audioUrl: null }) });
  instalarStub('audio/getStaticConnectors.js', { getStaticConnectors: async () => [] });

  const ArticleVoteStub = {
    findOneAndUpdate: (filtro, update) => {
      registro.guardados.push({ filtro, update });
      if (fallaGuardado) {
        const chain = { lean: () => Promise.reject(new Error('Mongo caído')) };
        return chain;
      }
      return consulta({
        userId: filtro.userId,
        articleId: filtro.articleId,
        vote: update.$set.vote,
        reason: update.$set.reason,
        ...update.$set,
      });
    },
    deleteOne: async (filtro) => { registro.borrados.push(filtro); return { deletedCount: 1 }; },
    find: (filtro) => { registro.consultados.push(filtro); return consulta(votos); },
    deleteMany: async () => {},
    VOTE_UP: 1,
    VOTE_DOWN: -1,
    VOTE_VALUES: [1, -1],
    DOWN_REASONS: ['aburrida', 'no_es_del_tema', 'ya_la_sabia', 'vieja'],
    CONTEXT_SOURCES: ['corrida', 'sin_contexto'],
  };
  instalarStub('models/ArticleVote.js', ArticleVoteStub);

  for (const modulo of ['utils/voteContext.js', 'routes/userRoutes.js']) {
    delete require.cache[require.resolve(path.join(SRC, modulo))];
  }

  const router = require(path.join(SRC, 'routes', 'userRoutes.js'));
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/users', router);

  const { signUserToken } = require(path.join(SRC, 'middleware', 'auth.js'));
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const headers = { Authorization: `Bearer ${signUserToken(USER_ID)}`, 'Content-Type': 'application/json' };
      const pedir = async (metodo, ruta, body) => {
        const r = await fetch(base + ruta, {
          method: metodo,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: r.status, body: await r.json() };
      };
      resolve({
        registro,
        get: (ruta) => pedir('GET', ruta),
        post: (ruta, body = {}) => pedir('POST', ruta, body),
        del: (ruta) => pedir('DELETE', ruta),
        sinToken: async (ruta) => {
          const r = await fetch(base + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          return { status: r.status };
        },
        cerrar: () => new Promise((ok) => server.close(ok)),
      });
    });
  });
}

const VOTAR = `/users/${USER_ID}/digest/vote`;

test('POST voto: el pulgar arriba se guarda pelado y con el contexto de la decisión', async () => {
  const restaurar = silenciar();
  const t = await montarRutas({ runs: [corrida(anidado([item()]))] });
  try {
    const r = await t.post(VOTAR, { articleId: ARTICLE_ID, vote: 1 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.vote, { articleId: ARTICLE_ID, vote: 1, reason: null });

    assert.equal(t.registro.guardados.length, 1);
    const { filtro, update } = t.registro.guardados[0];
    assert.deepEqual(filtro, { userId: USER_ID, articleId: ARTICLE_ID }, 'un voto por usuario y nota');
    assert.equal(update.$set.vote, 1);
    assert.equal(update.$set.reason, null);
    assert.equal(update.$set.contextSource, 'corrida');
    assert.equal(update.$set.zona, 'ETIQUETA');
    assert.equal(update.$set.edadHoras, 5.1);
    assert.equal(update.$set.importancia, 75);
    assert.equal(update.$set.puntaje, 80.9);
  } finally { await t.cerrar(); restaurar(); }
});

test('POST voto: acepta el cuerpo EXACTO que manda la app (reason: null en el pulgar arriba)', async () => {
  const restaurar = silenciar();
  const t = await montarRutas({ runs: [corrida(anidado([item()]))] });
  try {
    // services/api.ts manda siempre las tres claves, con reason en null cuando el voto es positivo.
    const arriba = await t.post(VOTAR, { articleId: ARTICLE_ID, vote: 1, reason: null });
    assert.equal(arriba.status, 200, 'un reason null junto a un pulgar arriba no es un motivo');
    assert.equal(arriba.body.vote.reason, null);

    const abajoSinMotivo = await t.post(VOTAR, { articleId: ARTICLE_ID, vote: -1, reason: null });
    assert.equal(abajoSinMotivo.status, 200, 'el pulgar abajo se guarda antes de elegir el motivo');
    assert.equal(abajoSinMotivo.body.vote.vote, -1);
    assert.equal(abajoSinMotivo.body.vote.reason, null);
  } finally { await t.cerrar(); restaurar(); }
});

test('POST voto: el pulgar abajo guarda el motivo', async () => {
  const restaurar = silenciar();
  const t = await montarRutas({ runs: [corrida(anidado([item()]))] });
  try {
    const r = await t.post(VOTAR, { articleId: ARTICLE_ID, vote: -1, reason: 'vieja' });
    assert.equal(r.status, 200);
    assert.equal(r.body.vote.reason, 'vieja');
    assert.equal(t.registro.guardados[0].update.$set.reason, 'vieja');
  } finally { await t.cerrar(); restaurar(); }
});

test('POST voto: los cuatro motivos del pulgar abajo se aceptan', async () => {
  const restaurar = silenciar();
  const t = await montarRutas({ runs: [corrida(anidado([item()]))] });
  try {
    for (const reason of ['aburrida', 'no_es_del_tema', 'ya_la_sabia', 'vieja']) {
      const r = await t.post(VOTAR, { articleId: ARTICLE_ID, vote: -1, reason });
      assert.equal(r.status, 200, reason);
      assert.equal(r.body.vote.reason, reason);
    }
  } finally { await t.cerrar(); restaurar(); }
});

test('POST voto: el cliente NO puede poner el contexto de la decisión', async () => {
  const restaurar = silenciar();
  const t = await montarRutas({ runs: [corrida(anidado([item()]))] });
  try {
    const r = await t.post(VOTAR, {
      articleId: ARTICLE_ID, vote: -1, reason: 'vieja',
      // todo esto tiene que ser ignorado: lo pone el servidor
      edadHoras: 999, importancia: 1, zona: 'INVENTADA', usedFallback: true, contextSource: 'corrida',
    });
    assert.equal(r.status, 200);
    const set = t.registro.guardados[0].update.$set;
    assert.equal(set.edadHoras, 5.1, 'el del digest guardado, no el del cliente');
    assert.equal(set.importancia, 75);
    assert.equal(set.zona, 'ETIQUETA');
    assert.equal(set.usedFallback, false);
    assert.equal(r.body.vote.articleId, ARTICLE_ID, 'la respuesta no devuelve las tripas del motor');
    assert.deepEqual(Object.keys(r.body.vote).sort(), ['articleId', 'reason', 'vote']);
  } finally { await t.cerrar(); restaurar(); }
});

test('POST voto: votar de nuevo CAMBIA el voto en vez de sumar otro', async () => {
  const restaurar = silenciar();
  const t = await montarRutas({ runs: [corrida(anidado([item()]))] });
  try {
    await t.post(VOTAR, { articleId: ARTICLE_ID, vote: 1 });
    const r = await t.post(VOTAR, { articleId: ARTICLE_ID, vote: -1, reason: 'aburrida' });
    assert.equal(r.status, 200);
    assert.equal(r.body.vote.vote, -1);

    assert.equal(t.registro.guardados.length, 2);
    for (const g of t.registro.guardados) {
      assert.deepEqual(g.filtro, { userId: USER_ID, articleId: ARTICLE_ID });
      assert.equal(g.update.$set.vote !== undefined, true);
    }
    assert.equal(t.registro.guardados[1].update.$set.reason, 'aburrida');
  } finally { await t.cerrar(); restaurar(); }
});

test('POST voto: una nota que ya no está en el digest se vota igual, con contexto vacío', async () => {
  const restaurar = silenciar();
  const t = await montarRutas({ runs: [corrida(anidado([item({ articleId: OTRO_ARTICLE_ID })]))] });
  try {
    const r = await t.post(VOTAR, { articleId: ARTICLE_ID, vote: -1, reason: 'ya_la_sabia' });
    assert.equal(r.status, 200, 'perder el contexto no es motivo para rechazar el voto');
    const set = t.registro.guardados[0].update.$set;
    assert.equal(set.contextSource, 'sin_contexto');
    assert.equal(set.zona, null);
    assert.equal(set.reason, 'ya_la_sabia');
  } finally { await t.cerrar(); restaurar(); }
});

test('POST voto: rechaza lo que no es un voto válido', async () => {
  const restaurar = silenciar();
  const t = await montarRutas({ runs: [corrida(anidado([item()]))] });
  try {
    const casos = [
      [{ articleId: ARTICLE_ID, vote: 0 }, 'INVALID_VOTE'],
      [{ articleId: ARTICLE_ID, vote: 5 }, 'INVALID_VOTE'],
      [{ articleId: ARTICLE_ID, vote: 'si' }, 'INVALID_VOTE'],
      [{ articleId: ARTICLE_ID }, 'INVALID_VOTE'],
      [{ articleId: 'no-es-un-id', vote: 1 }, 'INVALID_ARTICLE_ID'],
      [{ vote: 1 }, 'INVALID_ARTICLE_ID'],
      [{ articleId: ARTICLE_ID, vote: -1, reason: 'cualquiera' }, 'INVALID_VOTE_REASON'],
      [{ articleId: ARTICLE_ID, vote: 1, reason: 'vieja' }, 'REASON_NOT_ALLOWED'],
    ];
    for (const [body, code] of casos) {
      const r = await t.post(VOTAR, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.code, code, JSON.stringify(body));
    }
    assert.equal(t.registro.guardados.length, 0, 'nada inválido llega a la base');
  } finally { await t.cerrar(); restaurar(); }
});

test('POST voto: si falla el guardado contesta 500 y no miente', async () => {
  const restaurar = silenciar();
  const t = await montarRutas({ runs: [corrida(anidado([item()]))], fallaGuardado: true });
  try {
    const r = await t.post(VOTAR, { articleId: ARTICLE_ID, vote: 1 });
    assert.equal(r.status, 500);
    assert.equal(r.body.code, 'SAVE_VOTE_FAILED');
  } finally { await t.cerrar(); restaurar(); }
});

test('POST voto: sin token no se puede votar', async () => {
  const restaurar = silenciar();
  const t = await montarRutas();
  try {
    assert.equal((await t.sinToken(VOTAR)).status, 401);
  } finally { await t.cerrar(); restaurar(); }
});

test('POST voto: no se puede votar en nombre de otro usuario', async () => {
  const restaurar = silenciar();
  const t = await montarRutas();
  try {
    const r = await t.post(`/users/65f1a2b3c4d5e6f708192999/digest/vote`, { articleId: ARTICLE_ID, vote: 1 });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'FORBIDDEN_USER');
  } finally { await t.cerrar(); restaurar(); }
});

test('DELETE voto: saca el voto de esa nota y de nadie más', async () => {
  const restaurar = silenciar();
  const t = await montarRutas();
  try {
    const r = await t.del(`${VOTAR}/${ARTICLE_ID}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.deepEqual(t.registro.borrados, [{ userId: USER_ID, articleId: ARTICLE_ID }]);
  } finally { await t.cerrar(); restaurar(); }
});

test('DELETE voto: un articleId inválido no borra nada', async () => {
  const restaurar = silenciar();
  const t = await montarRutas();
  try {
    const r = await t.del(`${VOTAR}/no-es-un-id`);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'INVALID_ARTICLE_ID');
    assert.equal(t.registro.borrados.length, 0);
  } finally { await t.cerrar(); restaurar(); }
});

test('GET votos: devuelve lo que la app necesita para pintar los pulgares, sin las tripas del motor', async () => {
  const restaurar = silenciar();
  const guardados = [
    { articleId: ARTICLE_ID, vote: -1, reason: 'vieja', edadHoras: 20, importancia: 50, zona: 'ETIQUETA', puntaje: 41 },
    { articleId: OTRO_ARTICLE_ID, vote: 1, reason: null, edadHoras: 2, importancia: 80, zona: 'VERDE', puntaje: 86 },
  ];
  const t = await montarRutas({ votos: guardados });
  try {
    const r = await t.get(`/users/${USER_ID}/digest/votes`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items, [
      { articleId: ARTICLE_ID, vote: -1, reason: 'vieja' },
      { articleId: OTRO_ARTICLE_ID, vote: 1, reason: null },
    ]);
    assert.deepEqual(t.registro.consultados, [{ userId: USER_ID }], 'solo los votos de ese usuario');
  } finally { await t.cerrar(); restaurar(); }
});
