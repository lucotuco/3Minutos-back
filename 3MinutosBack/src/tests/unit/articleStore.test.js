'use strict';

/**
 * articleStore.js: las lecturas REALES que el motor le hace a `articles`, con el modelo de Mongoose falso.
 * Se comprueba lo que se le pide a Mongo (filtro, campos, orden, tope y timeout). Cómo se comportan esos
 * filtros con datos reales de Mongo se validó aparte con un motor de consultas con semántica de MongoDB
 * (bordes de 24 h, importancia 39/40/50, orden y desempate): ver la descripción del PR.
 * Correr:  npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// El modelo falso se instala ANTES de cargar el store (cada archivo de test corre en su propio proceso).
const llamadas = [];
let respuesta = [];

const modeloPath = require.resolve('../../models/Article');
require.cache[modeloPath] = {
  id: modeloPath,
  filename: modeloPath,
  loaded: true,
  exports: {
    find(filter) {
      const e = { filter, select: null, sort: null, limit: null, lean: false, maxTimeMS: null };
      llamadas.push(e);
      const q = {
        select(s) { e.select = s; return q; },
        sort(s) { e.sort = s; return q; },
        limit(n) { e.limit = n; return q; },
        lean() { e.lean = true; return q; },
        maxTimeMS(ms) { e.maxTimeMS = ms; return q; },
        then(res, rej) { return Promise.resolve(respuesta).then(res, rej); },
      };
      return q;
    },
  },
};

const store = require('../../utils/articleStore');
const { checkEligibility } = require('../../utils/eligibility');

const DESDE = new Date('2026-10-14T15:00:00.000Z');
const ultima = () => llamadas[llamadas.length - 1];

test.beforeEach(() => {
  llamadas.length = 0;
  respuesta = [];
});

// ================================================================ listCandidates
test('listCandidates (subtema): filtra por fecha, importancia, categoría y subtema; pide lo liviano, ordenado y con tope y timeout', async () => {
  respuesta = [{ _id: 'a' }];
  const out = await store.listCandidates({ category: 'Deportes', topic: 'Fútbol', minImportance: 40, since: DESDE });
  assert.deepEqual(out, [{ _id: 'a' }]);
  assert.equal(llamadas.length, 1);
  const q = ultima();
  assert.deepEqual(q.filter, {
    publishedAt: { $gte: DESDE },
    importanceScore: { $gte: 40 },
    category: 'Deportes',
    topic: 'Fútbol',
  });
  assert.equal(q.select, store.LIGHT_FIELDS);
  assert.deepEqual(q.sort, { publishedAt: -1, _id: 1 }, 'lo más nuevo primero y, a igual hora, por _id');
  assert.equal(q.limit, store.MAX_CANDIDATES);
  assert.equal(q.lean, true);
  assert.equal(q.maxTimeMS, store.QUERY_TIMEOUT_MS);
});

test('listCandidates (categoría completa): sin filtro de subtema', async () => {
  await store.listCandidates({ category: 'Deportes', minImportance: 40, since: DESDE });
  assert.deepEqual(ultima().filter, {
    publishedAt: { $gte: DESDE },
    importanceScore: { $gte: 40 },
    category: 'Deportes',
  });
});

test('listCandidates (rescate): la categoría menos el subtema pedido', async () => {
  await store.listCandidates({ category: 'Deportes', excludeTopic: 'Fútbol', minImportance: 50, since: DESDE });
  assert.deepEqual(ultima().filter, {
    publishedAt: { $gte: DESDE },
    importanceScore: { $gte: 50 },
    category: 'Deportes',
    topic: { $ne: 'Fútbol' },
  });
});

test('listCandidates: si vienen topic y excludeTopic manda topic', async () => {
  await store.listCandidates({ category: 'Deportes', topic: 'Tenis', excludeTopic: 'Fútbol', minImportance: 40, since: DESDE });
  assert.equal(ultima().filter.topic, 'Tenis');
});

test('listCandidates: el piso de importancia y la fecha son los que se piden (no valores fijos)', async () => {
  await store.listCandidates({ category: 'Economía', minImportance: 77, since: new Date('2026-01-02T03:04:05.000Z') });
  assert.deepEqual(ultima().filter.importanceScore, { $gte: 77 });
  assert.deepEqual(ultima().filter.publishedAt, { $gte: new Date('2026-01-02T03:04:05.000Z') });
});

test('listCandidates: un error de Mongo (por ejemplo el timeout) se propaga, no se traga', async () => {
  respuesta = Promise.reject(new Error('operation exceeded time limit'));
  respuesta.catch(() => {}); // evita el aviso de "unhandled" mientras el test llega a esperarla
  await assert.rejects(() => store.listCandidates({ category: 'Deportes', minImportance: 40, since: DESDE }), /time limit/);
});

test('constantes: timeout de 8 s y tope de 1000 notas por lectura', () => {
  assert.equal(store.QUERY_TIMEOUT_MS, 8000);
  assert.equal(store.MAX_CANDIDATES, 1000);
});

// ================================================================ campos
test('LIGHT_FIELDS trae todo lo que mira la elegibilidad (si falta alguno, esa regla se apaga sin avisar) y no trae el vector', () => {
  const campos = new Set(store.LIGHT_FIELDS.split(/\s+/));
  for (const f of ['_id', 'url', 'title', 'publishedAt', 'importanceScore', 'category', 'topic', 'geoScope', 'contentType', 'section', 'tags', 'sourceName']) {
    assert.ok(campos.has(f), `falta ${f} en LIGHT_FIELDS`);
  }
  assert.ok(!campos.has('embedding'), 'la lectura liviana no trae el embedding');
  assert.ok(!campos.has('rawSummary'), 'ni el resumen');
});

test('con los campos livianos alcanza para decidir la elegibilidad: la regla de país de Sociedad funciona con ellos', () => {
  // Lo que devuelve Mongo con .select(LIGHT_FIELDS): solo esos campos de la nota completa.
  const comoLaTrae = (extra) => {
    const completa = {
      _id: 'x', url: 'https://m.test/x', title: 'Titulo', publishedAt: new Date('2026-10-15T10:00:00Z'), importanceScore: 60,
      category: 'Sociedad', topic: 'Salud', geoScope: 'Argentina', section: 'sociedad', tags: [], sourceName: 'M',
      rawSummary: 'resumen', embedding: [1, 0], ...extra,
    };
    return Object.fromEntries(store.LIGHT_FIELDS.split(/\s+/).filter((c) => c in completa).map((c) => [c, completa[c]]));
  };
  const ahora = Date.parse('2026-10-15T12:00:00Z');
  assert.equal(checkEligibility(comoLaTrae({}), { now: ahora }).ok, true);
  assert.deepEqual(checkEligibility(comoLaTrae({ geoScope: 'Brasil' }), { now: ahora }).reasons, ['otro_pais']);
  assert.deepEqual(checkEligibility(comoLaTrae({ title: 'EN VIVO | minuto a minuto' }), { now: ahora }).reasons, ['previa_o_agenda']);
  assert.deepEqual(checkEligibility(comoLaTrae({ url: 'https://m.test/opinion/x/nota' }), { now: ahora }).reasons, ['opinion']);
  // El tipo que puso la IA también viaja en la lectura liviana (si faltara, esta regla se apagaría sin avisar).
  assert.deepEqual(checkEligibility(comoLaTrae({ contentType: 'servicio' }), { now: ahora }).reasons, ['servicio']);
  assert.deepEqual(checkEligibility(comoLaTrae({ contentType: 'publicidad' }), { now: ahora }).reasons, ['publicidad']);
  assert.equal(checkEligibility(comoLaTrae({ contentType: 'analisis' }), { now: ahora }).ok, true);
});

test('FULL_FIELDS trae lo que necesita el digest (los mismos campos que la búsqueda híbrida) y el embedding', () => {
  const campos = new Set(store.FULL_FIELDS.split(/\s+/));
  // Misma lista que proyecta searchArticlesBySimilarityAtlas.js (+ embedding para comparar historias).
  for (const f of ['_id', 'title', 'url', 'sourceName', 'section', 'region', 'tags', 'importanceScore', 'importanceLevel',
    'publishedAt', 'topic', 'category', 'geoScope', 'contentType', 'imageUrl', 'neutralTitle', 'neutralLead', 'neutralSummary', 'rawSummary',
    'contentSnippet', 'neutralityScore', 'politicalBiasRisk', 'curationStatus', 'embedding']) {
    assert.ok(campos.has(f), `falta ${f} en FULL_FIELDS`);
  }
});

// ================================================================ loadFull / loadEmbeddings
test('loadFull: trae los documentos completos por _id, con timeout, y devuelve un Map por String(_id)', async () => {
  respuesta = [{ _id: 'a', title: 'A', embedding: [1, 0] }, { _id: { toString: () => 'b' }, title: 'B' }];
  const out = await store.loadFull(['a', 'b']);
  const q = ultima();
  assert.deepEqual(q.filter, { _id: { $in: ['a', 'b'] } });
  assert.equal(q.select, store.FULL_FIELDS);
  assert.equal(q.lean, true);
  assert.equal(q.maxTimeMS, store.QUERY_TIMEOUT_MS);
  assert.equal(out.get('a').title, 'A');
  assert.deepEqual(out.get('a').embedding, [1, 0]);
  assert.equal(out.get('b').title, 'B');
  assert.equal(out.size, 2);
});

test('loadFull: sin ids (o con ids vacíos) no consulta nada', async () => {
  assert.equal((await store.loadFull([])).size, 0);
  assert.equal((await store.loadFull(undefined)).size, 0);
  assert.equal((await store.loadFull([null, undefined, ''])).size, 0);
  assert.equal(llamadas.length, 0);
});

test('loadEmbeddings: solo _id y embedding, con timeout; las notas sin vector no aparecen', async () => {
  respuesta = [
    { _id: 'a', embedding: [1, 0, 0] },
    { _id: 'b', embedding: [] },
    { _id: 'c' },
    { _id: 'd', embedding: null },
    { _id: 'e', embedding: [0, 1, 0] },
  ];
  const out = await store.loadEmbeddings(['a', 'b', 'c', 'd', 'e']);
  const q = ultima();
  assert.deepEqual(q.filter, { _id: { $in: ['a', 'b', 'c', 'd', 'e'] } });
  assert.equal(q.select, '_id embedding');
  assert.equal(q.lean, true);
  assert.equal(q.maxTimeMS, store.QUERY_TIMEOUT_MS);
  assert.deepEqual([...out.keys()].sort(), ['a', 'e']);
  assert.deepEqual(out.get('a'), [1, 0, 0]);
});

test('loadEmbeddings: sin ids no consulta nada', async () => {
  assert.equal((await store.loadEmbeddings([])).size, 0);
  assert.equal((await store.loadEmbeddings(null)).size, 0);
  assert.equal(llamadas.length, 0);
});
