'use strict';

/**
 * buildUserNewsDigest con el motor y la curación con IA FALSOS: qué se le pasa al motor y qué datos de
 * cada nota quedan guardados en el digest (la fecha de publicación es la que usa staleDigest.js para
 * revisar la edad cuando el usuario abre el digest; el nivel y la edad al elegir son para medir).
 * Correr:  npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test.before(() => {
  for (const m of ['log', 'warn', 'error']) console[m] = () => {};
});

// ---------------------------------------------------------------- falsos (antes de cargar el módulo)
const llamadasMotor = [];
const curaciones = [];
let picks = [];
let errorDelMotor = null;
let curacion = async (id) => ({
  neutralTitle: `Titulo ${id}`, neutralLead: `Bajada ${id}`, neutralSummary: `Resumen ${id}`,
  cached: false, neutralityScore: 80, politicalBiasRisk: 'low',
});

function instalarFalso(rel, exportaciones) {
  const archivo = require.resolve(path.join(__dirname, '..', '..', rel));
  require.cache[archivo] = { id: archivo, filename: archivo, loaded: true, exports: exportaciones };
}
instalarFalso('utils/pickBestArticlePerTopic.js', {
  pickBestArticlePerTopic: async (topics, opts) => {
    llamadasMotor.push({ topics, opts });
    if (errorDelMotor) throw errorDelMotor;
    return picks;
  },
});
instalarFalso('curation/generateNeutralCuration.js', {
  generateNeutralCuration: async (id) => { curaciones.push(String(id)); return curacion(id); },
});

const { buildUserNewsDigest } = require('../../utils/buildUserNewsDigest');

test.beforeEach(() => {
  llamadasMotor.length = 0;
  curaciones.length = 0;
  picks = [];
  errorDelMotor = null;
});

const PUBLICADA = new Date('2026-10-15T10:00:00.000Z');

function pick(topic, extra = {}) {
  const { article: delArticulo = {}, ...resto } = extra;
  return {
    topic,
    queryExpanded: topic,
    article: {
      _id: `id-${topic}`, title: `Original ${topic}`, url: `https://m.test/${topic}`, section: 'deportes', region: 'Argentina',
      category: 'Deportes', publishedAt: PUBLICADA, tags: ['a'], imageUrl: 'https://img.test/1.jpg', importanceScore: 70,
      score: 0.9, finalScore: 88, ...delArticulo,
    },
    usedFallback: false,
    fallbackCategory: null,
    matchZone: 'ETIQUETA',
    matchScore: null,
    matchReason: 'ETIQUETA buena 3h imp=70 (candidato #1 de 4 elegibles)',
    corralCategory: 'Deportes',
    candidatesEvaluated: 4,
    tier: 'buena',
    ageHours: 3,
    ...resto,
  };
}

// ================================================================ lo que se le pasa al motor
test('le pasa al motor los temas, el historial (URLs, títulos y embeddings de lo ya visto) y el tamaño de ventana', async () => {
  const vistos = [{ title: 'ya vista', vector: [1, 0] }];
  await buildUserNewsDigest({
    topics: ['Fútbol', 'river plate'], alreadyShownUrls: ['https://m.test/vista'], alreadyShownTitles: ['Vista'], seenEmbeddings: vistos, perTopicLimit: 7,
  });
  assert.equal(llamadasMotor.length, 1);
  assert.deepEqual(llamadasMotor[0].topics, ['Fútbol', 'river plate']);
  assert.deepEqual(llamadasMotor[0].opts, {
    perTopicLimit: 7, alreadyShownUrls: ['https://m.test/vista'], alreadyShownTitles: ['Vista'], seenEmbeddings: vistos, judgeWaitMs: null,
  });
});

test('por defecto: ventana de 10, sin historial y el presupuesto de espera de los jueces de un digest en vivo (null)', async () => {
  await buildUserNewsDigest({ topics: ['Fútbol'] });
  assert.deepEqual(llamadasMotor[0].opts, {
    perTopicLimit: 10, alreadyShownUrls: [], alreadyShownTitles: [], seenEmbeddings: [], judgeWaitMs: null,
  });
});

test('le pasa al motor el presupuesto de espera a los jueces que se le dio', async () => {
  await buildUserNewsDigest({ topics: ['Fútbol'], judgeWaitMs: 4000 });
  assert.equal(llamadasMotor[0].opts.judgeWaitMs, 4000);
  await buildUserNewsDigest({ topics: ['Fútbol'], judgeWaitMs: 0 });
  assert.equal(llamadasMotor[1].opts.judgeWaitMs, 0, 'cero (solo caché) no se confunde con "sin dato"');
});

test('sin temas devuelve un digest vacío y no llama al motor', async () => {
  assert.deepEqual(await buildUserNewsDigest({ topics: [] }), { items: [] });
  assert.deepEqual(await buildUserNewsDigest(), { items: [] });
  assert.equal(llamadasMotor.length, 0);
});

test('un error del motor se propaga (el armado del digest falla entero)', async () => {
  errorDelMotor = new Error('mongo caído');
  await assert.rejects(() => buildUserNewsDigest({ topics: ['Fútbol'] }), /mongo caído/);
});

// ================================================================ lo que queda guardado de cada nota
test('cada ítem guarda la fecha de publicación, el nivel y la edad al elegir, y la trazabilidad de la elección', async () => {
  picks = [pick('Fútbol')];
  const { items } = await buildUserNewsDigest({ topics: ['Fútbol'] });
  assert.equal(items.length, 1);
  const it = items[0];
  assert.equal(it.articleId, 'id-Fútbol');
  assert.equal(it.url, 'https://m.test/Fútbol');
  assert.equal(it.publishedAt, PUBLICADA, 'staleDigest.js revisa la edad con esta fecha al abrir el digest');
  assert.equal(it.category, 'Deportes');
  assert.equal(it.tier, 'buena');
  assert.equal(it.ageHoursAtPick, 3);
  assert.equal(it.matchZone, 'ETIQUETA');
  assert.equal(it.matchScore, null);
  assert.equal(it.matchReason, 'ETIQUETA buena 3h imp=70 (candidato #1 de 4 elegibles)');
  assert.equal(it.corralCategory, 'Deportes');
  assert.equal(it.candidatesEvaluated, 4);
  assert.equal(it.usedFallback, false);
  assert.equal(it.fallbackCategory, null);
  assert.equal(it.topic, 'Fútbol');
  assert.equal(it.originalTitle, 'Original Fútbol');
  assert.equal(it.title, 'Titulo id-Fútbol', 'el título que ve el usuario es el curado');
  assert.deepEqual(curaciones, ['id-Fútbol']);
});

test('una nota recién publicada (0 h) guarda edad 0, no nula', async () => {
  picks = [pick('Fútbol', { ageHours: 0 })];
  const { items } = await buildUserNewsDigest({ topics: ['Fútbol'] });
  assert.equal(items[0].ageHoursAtPick, 0);
});

test('un rescate se guarda como tal (sugerida, con su categoría)', async () => {
  picks = [pick('Fútbol', { usedFallback: true, fallbackCategory: 'Deportes', matchZone: 'RESCATE', tier: 'sugerida', ageHours: 12.5 })];
  const { items } = await buildUserNewsDigest({ topics: ['Fútbol'] });
  assert.equal(items[0].usedFallback, true);
  assert.equal(items[0].fallbackCategory, 'Deportes');
  assert.equal(items[0].matchZone, 'RESCATE');
  assert.equal(items[0].tier, 'sugerida');
  assert.equal(items[0].ageHoursAtPick, 12.5);
});

test('un tema sin nota queda afuera del digest (mejor un hueco que una mala) y los demás siguen en orden', async () => {
  picks = [
    pick('Fútbol'),
    { topic: 'Economía', queryExpanded: 'Economía', article: null, usedFallback: false, matchZone: null, matchReason: 'sin_candidatos', candidatesEvaluated: 0, tier: null, ageHours: null },
    pick('river plate', { matchZone: 'VERDE', matchScore: 0.97 }),
  ];
  const { items } = await buildUserNewsDigest({ topics: ['Fútbol', 'Economía', 'river plate'] });
  assert.deepEqual(items.map((i) => i.topic), ['Fútbol', 'river plate']);
  assert.equal(items[1].matchScore, 0.97);
  assert.deepEqual(curaciones, ['id-Fútbol', 'id-river plate'], 'solo se cura lo que se entrega');
});

test('si la curación con IA falla, el ítem sale igual con textos de respaldo y con su fecha, nivel y edad', async () => {
  picks = [pick('Fútbol', { article: { rawSummary: 'Resumen original de la nota.' } })];
  curacion = async () => { throw new Error('OpenAI 429'); };
  try {
    const { items } = await buildUserNewsDigest({ topics: ['Fútbol'] });
    assert.equal(items.length, 1);
    assert.equal(items[0].curationFallback, true);
    assert.equal(items[0].publishedAt, PUBLICADA);
    assert.equal(items[0].tier, 'buena');
    assert.equal(items[0].ageHoursAtPick, 3);
    assert.ok(items[0].title && items[0].summary);
  } finally {
    curacion = async (id) => ({ neutralTitle: `Titulo ${id}`, neutralLead: `Bajada ${id}`, neutralSummary: `Resumen ${id}`, cached: false, neutralityScore: 80, politicalBiasRisk: 'low' });
  }
});
