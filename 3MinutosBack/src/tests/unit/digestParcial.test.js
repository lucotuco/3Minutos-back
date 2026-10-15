'use strict';

/**
 * Tests del armado de digest (buildDigestForUser) en sus dos modos y de las exclusiones que usa:
 *   - completo: los temas del usuario, excluyendo lo que ya vio en 48 h
 *   - parcial (reposición de notas vencidas): solo esos temas, excluyendo además las notas que se quedan
 * Mongo, el motor y el historial son falsos. Correr:  npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..');
const USER_ID = '65f1a2b3c4d5e6f708192a3b';

const { exclusionsFromItems, mergeExclusions, lockKeyFor } = require('../../utils/digestExclusions');

// ---------------------------------------------------------------- exclusionsFromItems / mergeExclusions / lockKeyFor

test('exclusionsFromItems: urls, títulos y embeddings de las notas que se quedan', async () => {
  const items = [
    { url: 'https://m.test/1', articleId: 'a1', neutralTitle: 'Uno', title: 'Original uno' },
    { url: 'https://m.test/2', articleId: 'a2', title: 'Dos' },
    { url: 'https://m.test/3', articleId: 'a3', title: 'Sin vector' },
    { url: 'https://m.test/4', title: 'Sin id' },
    null,
  ];
  let pedidos = null;
  const r = await exclusionsFromItems(items, {
    loadEmbeddings: async (ids) => { pedidos = ids; return new Map([['a1', [1, 0]], ['a2', [0, 1]]]); },
  });
  assert.deepEqual(r.urls, ['https://m.test/1', 'https://m.test/2', 'https://m.test/3', 'https://m.test/4']);
  assert.deepEqual(r.titles, ['Uno', 'Dos', 'Sin vector', 'Sin id']);
  assert.deepEqual(pedidos.sort(), ['a1', 'a2', 'a3']);
  assert.deepEqual(r.seenEmbeddings, [{ title: 'Uno', vector: [1, 0] }, { title: 'Dos', vector: [0, 1] }]);
});

test('exclusionsFromItems: sin notas no consulta nada', async () => {
  let consultas = 0;
  const r = await exclusionsFromItems([], { loadEmbeddings: async () => { consultas++; return new Map(); } });
  assert.deepEqual(r, { urls: [], titles: [], seenEmbeddings: [] });
  assert.equal(consultas, 0);
  assert.deepEqual(await exclusionsFromItems(undefined, { loadEmbeddings: async () => new Map() }), { urls: [], titles: [], seenEmbeddings: [] });
});

test('mergeExclusions: junta sin repetir urls ni títulos y acepta partes vacías o nulas', () => {
  const r = mergeExclusions(
    { urls: ['a', 'b'], titles: ['A'], seenEmbeddings: [{ title: 'A', vector: [1] }] },
    null,
    { urls: ['b', 'c'], titles: ['A', 'C'], seenEmbeddings: [{ title: 'C', vector: [2] }] },
    {}
  );
  assert.deepEqual(r.urls, ['a', 'b', 'c']);
  assert.deepEqual(r.titles, ['A', 'C']);
  assert.equal(r.seenEmbeddings.length, 2);
  assert.deepEqual(mergeExclusions(), { urls: [], titles: [], seenEmbeddings: [] });
});

test('lockKeyFor: el armado completo es solo el usuario; el parcial suma temas y notas que se quedan', () => {
  assert.equal(lockKeyFor('u1'), 'u1');
  assert.equal(lockKeyFor('u1', { onlyTopics: null }), 'u1');
  const k1 = lockKeyFor('u1', { onlyTopics: ['Fútbol'], keepItems: [{ url: 'b' }, { url: 'a' }] });
  const k2 = lockKeyFor('u1', { onlyTopics: ['Fútbol'], keepItems: [{ url: 'a' }, { url: 'b' }] });
  assert.equal(k1, k2, 'el orden de las notas que se quedan no cambia la clave');
  assert.notEqual(k1, 'u1');
  assert.notEqual(k1, lockKeyFor('u1', { onlyTopics: ['Economía'], keepItems: [{ url: 'a' }, { url: 'b' }] }));
  assert.notEqual(k1, lockKeyFor('u1', { onlyTopics: ['Fútbol'], keepItems: [{ url: 'a' }] }));
  assert.notEqual(k1, lockKeyFor('u2', { onlyTopics: ['Fútbol'], keepItems: [{ url: 'a' }, { url: 'b' }] }));
});

// ---------------------------------------------------------------- buildDigestForUser

function instalarStub(relPath, exports) {
  const abs = require.resolve(path.join(SRC, relPath));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports, children: [], paths: [] };
}

/** Carga una copia nueva de buildDigestForUser con todo lo de afuera falso. */
function montar({ usuario, historial, motor, embeddings = new Map() } = {}) {
  const registro = { motor: [], logs: [], embeddingsPedidos: [] };

  instalarStub('models/UserPreference.js', {
    findById: () => ({ lean: async () => (usuario === undefined ? { _id: USER_ID, name: 'Lucas', isActive: true, deliveryTime: '08:00', topics: ['Fútbol', 'Economía', 'river plate'] } : usuario) }),
  });
  instalarStub('models/UserDeliveryRun.js', {});
  instalarStub('models/DigestTestLog.js', { create: async (doc) => { registro.logs.push(doc); } });
  instalarStub('utils/getAlreadyShownUrlsForUser.js', {
    getAlreadyShownHistoryForUser: async () => historial || { urls: ['https://m.test/visto'], titles: ['Visto'], seenEmbeddings: [{ title: 'Visto', vector: [1, 0] }] },
  });
  instalarStub('utils/articleStore.js', {
    loadEmbeddings: async (ids) => { registro.embeddingsPedidos.push(ids); return embeddings; },
  });
  instalarStub('utils/buildUserNewsDigest.js', {
    buildUserNewsDigest: async (args) => {
      registro.motor.push(args);
      await new Promise((ok) => setTimeout(ok, 10));
      if (motor) return motor(args);
      return { items: args.topics.map((t) => ({ topic: t, articleId: `id-${t}`, url: `https://m.test/${t}`, title: `Nota ${t}`, publishedAt: new Date() })) };
    },
  });

  const archivo = require.resolve(path.join(SRC, 'utils', 'buildDigestForUser.js'));
  delete require.cache[archivo];
  delete require.cache[require.resolve(path.join(SRC, 'utils', 'digestExclusions.js'))];
  const { buildDigestForUser } = require(archivo);
  return { buildDigestForUser, registro };
}

const sinRuido = async (fn) => {
  const o = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, o); }
};

test('armado completo: usa los temas del usuario y excluye solo lo que ya vio', () => sinRuido(async () => {
  const { buildDigestForUser, registro } = montar();
  const r = await buildDigestForUser(USER_ID);

  assert.deepEqual(registro.motor[0].topics, ['Fútbol', 'Economía', 'river plate']);
  assert.deepEqual(registro.motor[0].alreadyShownUrls, ['https://m.test/visto']);
  assert.deepEqual(registro.motor[0].alreadyShownTitles, ['Visto']);
  assert.equal(registro.motor[0].seenEmbeddings.length, 1);
  assert.equal(registro.embeddingsPedidos.length, 0, 'sin notas que se quedan no hay nada que buscar');

  assert.equal(r.user.id, USER_ID);
  assert.deepEqual(r.user.topics, ['Fútbol', 'Economía', 'river plate']);
  assert.equal(r.digest.items.length, 3);
  assert.equal(r.digest.audioUrl, null);
  assert.equal(registro.logs[0].motivo, 'refresh_test');
}));

test('armado parcial: solo esos temas, y además excluye las notas que se quedan (url, título y misma historia)', () => sinRuido(async () => {
  const keepItems = [
    { url: 'https://m.test/queda1', articleId: 'k1', neutralTitle: 'Se queda 1' },
    { url: 'https://m.test/queda2', articleId: 'k2', title: 'Se queda 2' },
  ];
  const embeddings = new Map([['k1', [0, 1]], ['k2', [0.6, 0.8]]]);
  const { buildDigestForUser, registro } = montar({ embeddings });

  const r = await buildDigestForUser(USER_ID, { onlyTopics: ['Economía'], keepItems });

  const args = registro.motor[0];
  assert.deepEqual(args.topics, ['Economía'], 'no se rearman los otros temas');
  assert.deepEqual(args.alreadyShownUrls.sort(), ['https://m.test/queda1', 'https://m.test/queda2', 'https://m.test/visto']);
  assert.deepEqual(args.alreadyShownTitles.sort(), ['Se queda 1', 'Se queda 2', 'Visto']);
  assert.equal(args.seenEmbeddings.length, 3, 'el historial + las dos que se quedan');
  assert.deepEqual(registro.embeddingsPedidos[0].sort(), ['k1', 'k2']);

  assert.equal(r.digest.items.length, 1);
  assert.equal(r.digest.items[0].topic, 'Economía');
  assert.deepEqual(r.user.topics, ['Fútbol', 'Economía', 'river plate'], 'el usuario sigue con sus tres temas');
  assert.equal(registro.logs[0].motivo, 'reemplazo_vencidas', 'queda separado de los armados completos en el log');
}));

test('armado parcial con la misma lista de temas repetida (dos notas del mismo tema)', () => sinRuido(async () => {
  const { buildDigestForUser, registro } = montar();
  await buildDigestForUser(USER_ID, { onlyTopics: ['Fútbol', 'Fútbol'], keepItems: [] });
  assert.deepEqual(registro.motor[0].topics, ['Fútbol', 'Fútbol']);
}));

test('el log de pruebas guarda el nivel y la edad con que se eligió cada nota', () => sinRuido(async () => {
  const { buildDigestForUser, registro } = montar({
    motor: async () => ({
      items: [
        { topic: 'Fútbol', articleId: 'a', url: 'u1', title: 'A', tier: 'buena', ageHoursAtPick: 3.2, matchZone: 'ETIQUETA', matchReason: 'ETIQUETA buena 3.2h imp=70 (candidato #1 de 4 elegibles)' },
        { topic: 'river plate', articleId: 'b', url: 'u2', title: 'B', tier: 'sugerida', ageHoursAtPick: 18, usedFallback: true, matchZone: 'RESCATE' },
      ],
    }),
  });
  await buildDigestForUser(USER_ID);
  await new Promise((ok) => setImmediate(ok));
  const [a, b] = registro.logs[0].noticias;
  assert.equal(a.nivel, 'buena');
  assert.equal(a.edadHoras, 3.2);
  assert.equal(a.zona, 'ETIQUETA');
  assert.equal(b.nivel, 'sugerida');
  assert.equal(b.edadHoras, 18);
  assert.equal(b.usedFallback, true);
}));

test('candado: dos armados completos simultáneos comparten el trabajo', () => sinRuido(async () => {
  const { buildDigestForUser, registro } = montar();
  const [a, b] = await Promise.all([buildDigestForUser(USER_ID), buildDigestForUser(USER_ID)]);
  assert.equal(registro.motor.length, 1);
  assert.strictEqual(a, b);
}));

test('candado: dos reposiciones iguales simultáneas comparten el trabajo', () => sinRuido(async () => {
  const { buildDigestForUser, registro } = montar();
  const opts = { onlyTopics: ['Economía'], keepItems: [{ url: 'x', articleId: 'k' }] };
  await Promise.all([buildDigestForUser(USER_ID, opts), buildDigestForUser(USER_ID, { ...opts })]);
  assert.equal(registro.motor.length, 1);
}));

test('candado: una reposición y un armado completo NO se esperan entre sí', () => sinRuido(async () => {
  const { buildDigestForUser, registro } = montar();
  const [completo, parcial] = await Promise.all([
    buildDigestForUser(USER_ID),
    buildDigestForUser(USER_ID, { onlyTopics: ['Economía'], keepItems: [] }),
  ]);
  assert.equal(registro.motor.length, 2);
  assert.equal(completo.digest.items.length, 3);
  assert.equal(parcial.digest.items.length, 1);
}));

test('candado: reposiciones de temas distintos no se pisan', () => sinRuido(async () => {
  const { buildDigestForUser, registro } = montar();
  const [a, b] = await Promise.all([
    buildDigestForUser(USER_ID, { onlyTopics: ['Economía'], keepItems: [] }),
    buildDigestForUser(USER_ID, { onlyTopics: ['Fútbol'], keepItems: [] }),
  ]);
  assert.equal(registro.motor.length, 2);
  assert.equal(a.digest.items[0].topic, 'Economía');
  assert.equal(b.digest.items[0].topic, 'Fútbol');
}));

test('candado: se libera aunque el armado falle, y el siguiente intento vuelve a correr', () => sinRuido(async () => {
  let intento = 0;
  const { buildDigestForUser, registro } = montar({
    motor: async (args) => {
      intento++;
      if (intento === 1) throw new Error('OpenAI caído');
      return { items: args.topics.map((t) => ({ topic: t, articleId: t, url: t, title: t })) };
    },
  });
  await assert.rejects(() => buildDigestForUser(USER_ID), /OpenAI caído/);
  const r = await buildDigestForUser(USER_ID);
  assert.equal(r.digest.items.length, 3);
  assert.equal(registro.motor.length, 2);
}));

test('un usuario inexistente o inactivo no arma nada', () => sinRuido(async () => {
  for (const usuario of [null, { _id: USER_ID, isActive: false, topics: ['Fútbol'] }]) {
    const { buildDigestForUser, registro } = montar({ usuario });
    await assert.rejects(() => buildDigestForUser(USER_ID), /User not found or inactive/);
    assert.equal(registro.motor.length, 0);
  }
}));
