'use strict';

/**
 * Guardado de una nota nueva (saveNormalizedArticle). La ingesta calcula el vector de cada nota antes de pasarla por la
 * IA (para descartar duplicados) y, al guardarla, lo recalcula con los tags que puso la IA: los tags forman parte del
 * texto del embedding a propósito. Si la IA falló, o dejó los mismos tags, el texto es el mismo y el segundo cálculo
 * es una llamada a OpenAI que paga el mismo vector dos veces. Estos tests fijan cuándo se reusa y cuándo no:
 * solo cuando el vector se calculó con exactamente el texto que se guarda; en cualquier otro caso se calcula de nuevo.
 * OpenAI y Mongo son falsos. Correr:  npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test.before(() => {
  for (const m of ['log', 'warn', 'error']) console[m] = () => {};
});

// ---------------------------------------------------------------- falsos (antes de cargar los módulos)
function instalarFalso(rel, exportaciones) {
  const archivo = require.resolve(path.join(__dirname, '..', '..', rel));
  require.cache[archivo] = { id: archivo, filename: archivo, loaded: true, exports: exportaciones };
}

/** El vector depende del texto: así se ve de qué texto salió el que se guardó. */
const vectorDe = (texto) => [1, String(texto).length / 100, 0.5];

const llamadasEmbedding = [];
let respuestaEmbedding = async ({ input }) => ({ data: [{ embedding: vectorDe(input) }] });
instalarFalso('config/openai.js', {
  openaiEmbeddings: { embeddings: { create: async (args) => { llamadasEmbedding.push(args); return respuestaEmbedding(args); } } },
  openaiReview: {},
});

let yaGuardada = null;
let candidatos = [];
const busquedasVectoriales = [];
const creadas = [];
instalarFalso('models/Article.js', {
  findOne: () => ({ select: async () => yaGuardada }),
  aggregate: async (pipeline) => { busquedasVectoriales.push(pipeline); return candidatos; },
  create: async (doc) => {
    creadas.push(doc);
    return { _id: 'nueva', classificationStatus: doc.classificationStatus, curationStatus: doc.curationStatus };
  },
});

const { saveNormalizedArticle } = require('../../ingestion/saveNormalizedArticle');
const { buildEmbeddingText } = require('../../embeddings/buildEmbeddingsText');
const { EMBEDDING_MODEL } = require('../../embeddings/generateArticleEmbeddings');

test.beforeEach(() => {
  llamadasEmbedding.length = 0;
  busquedasVectoriales.length = 0;
  creadas.length = 0;
  yaGuardada = null;
  candidatos = [];
  respuestaEmbedding = async ({ input }) => ({ data: [{ embedding: vectorDe(input) }] });
});

const VECTOR_VIEJO = [0.9, 0.1, 0.1];

/** Una nota como llega a saveNormalizedArticle: con el vector que calculó el chequeo de duplicados para su texto de entonces. */
function notaConVector(extra = {}) {
  const nota = {
    url: 'https://medio.test/nota-1',
    title: 'Se vota la reforma laboral en el Senado',
    rawSummary: 'La sesión empieza a las 10 y el oficialismo cuenta con los votos.',
    tags: ['política', 'congreso'],
  };
  nota.embeddingText = buildEmbeddingText(nota);
  return Object.assign(nota, {
    embedding: VECTOR_VIEJO, embeddingStatus: 'done', embeddingModel: EMBEDDING_MODEL,
  }, extra);
}

// ================================================================ se reusa
test('texto sin cambios: se guarda el vector que la nota ya traía, sin llamar a OpenAI', async () => {
  const nota = notaConVector();
  const r = await saveNormalizedArticle(nota);

  assert.equal(r.status, 'created');
  assert.equal(r.embeddingReused, true);
  assert.equal(llamadasEmbedding.length, 0, 'ni una llamada a OpenAI');

  assert.equal(creadas.length, 1);
  assert.deepEqual(creadas[0].embedding, VECTOR_VIEJO);
  assert.equal(creadas[0].embeddingModel, EMBEDDING_MODEL);
  assert.equal(creadas[0].embeddingStatus, 'done');
  assert.equal(creadas[0].embeddingError, '');
  assert.equal(creadas[0].embeddingText, buildEmbeddingText(nota));
});

test('el vector reusado es el que decide si la nota es un duplicado de otra de los últimos 3 días', async () => {
  const nota = notaConVector();
  await saveNormalizedArticle(nota);

  assert.equal(busquedasVectoriales.length, 1);
  const busqueda = busquedasVectoriales[0][0].$vectorSearch;
  assert.deepEqual(busqueda.queryVector, VECTOR_VIEJO);

  // Un candidato idéntico (coseno 1 ≥ 0.92): se descarta, no se guarda y tampoco costó una llamada.
  llamadasEmbedding.length = 0;
  creadas.length = 0;
  candidatos = [{ title: 'La misma nota en otro medio', embedding: VECTOR_VIEJO }];
  const repetida = await saveNormalizedArticle(notaConVector({ url: 'https://medio.test/nota-2' }));
  assert.deepEqual([repetida.status, repetida.reason], ['skipped', 'semantic_duplicate']);
  assert.equal(creadas.length, 0);
  assert.equal(llamadasEmbedding.length, 0);
});

test('los espacios de los bordes del texto anterior no cuentan: es el mismo texto que se le mandó a OpenAI', async () => {
  const nota = notaConVector();
  nota.embeddingText = `\n  ${nota.embeddingText}  \n`;
  const r = await saveNormalizedArticle(nota);

  assert.equal(r.embeddingReused, true);
  assert.equal(llamadasEmbedding.length, 0);
  assert.deepEqual(creadas[0].embedding, VECTOR_VIEJO);
});

test('con el texto sin cambios la nota se guarda aunque OpenAI esté caído', async () => {
  respuestaEmbedding = async () => { throw new Error('OpenAI caído'); };
  const r = await saveNormalizedArticle(notaConVector());

  assert.equal(r.status, 'created');
  assert.equal(llamadasEmbedding.length, 0);
  assert.equal(creadas.length, 1);
});

// ================================================================ se recalcula
test('la IA cambió los tags: el vector viejo ya no describe la nota, se calcula uno con los tags nuevos', async () => {
  const nota = notaConVector();
  nota.tags = ['reforma laboral', 'senado'];
  const r = await saveNormalizedArticle(nota);

  assert.equal(r.status, 'created');
  assert.equal(r.embeddingReused, false);
  assert.equal(llamadasEmbedding.length, 1);

  const texto = buildEmbeddingText(nota);
  assert.match(texto, /^Tags: reforma laboral, senado\n/);
  assert.equal(llamadasEmbedding[0].input, texto, 'a OpenAI se le manda el texto con los tags de la IA');
  assert.equal(llamadasEmbedding[0].model, EMBEDDING_MODEL);

  assert.deepEqual(creadas[0].embedding, vectorDe(texto), 'se guarda el vector nuevo');
  assert.notDeepEqual(creadas[0].embedding, VECTOR_VIEJO);
  assert.equal(creadas[0].embeddingText, texto, 'y el texto con el que se calculó');
  assert.deepEqual(busquedasVectoriales[0][0].$vectorSearch.queryVector, vectorDe(texto), 'el duplicado se busca con el vector nuevo');
});

test('cualquier diferencia en el texto (tags, título o bajada) obliga a recalcular', async () => {
  const cambios = {
    tags: (n) => { n.tags = ['otro']; },
    'tags quitados': (n) => { n.tags = []; },
    título: (n) => { n.title = 'Otro título'; },
    bajada: (n) => { n.rawSummary = 'Otra bajada.'; },
  };
  for (const [nombre, cambiar] of Object.entries(cambios)) {
    llamadasEmbedding.length = 0;
    creadas.length = 0;
    const nota = notaConVector({ url: `https://medio.test/${encodeURIComponent(nombre)}` });
    cambiar(nota);
    const r = await saveNormalizedArticle(nota);
    assert.equal(r.embeddingReused, false, nombre);
    assert.equal(llamadasEmbedding.length, 1, nombre);
    assert.deepEqual(creadas[0].embedding, vectorDe(buildEmbeddingText(nota)), nombre);
  }
});

test('sin un vector utilizable (falta, está vacío o no es una lista) se calcula', async () => {
  for (const embedding of [undefined, null, [], 'abc', {}]) {
    llamadasEmbedding.length = 0;
    creadas.length = 0;
    const r = await saveNormalizedArticle(notaConVector({ embedding }));
    assert.equal(r.embeddingReused, false, JSON.stringify(embedding));
    assert.equal(llamadasEmbedding.length, 1, JSON.stringify(embedding));
    assert.notDeepEqual(creadas[0].embedding, VECTOR_VIEJO);
  }
});

test('un vector que no está marcado como terminado no se reusa', async () => {
  for (const embeddingStatus of ['pending', 'error', undefined]) {
    llamadasEmbedding.length = 0;
    const r = await saveNormalizedArticle(notaConVector({ embeddingStatus }));
    assert.equal(r.embeddingReused, false, String(embeddingStatus));
    assert.equal(llamadasEmbedding.length, 1, String(embeddingStatus));
  }
});

test('un vector de otro modelo no se reusa: los vectores de modelos distintos no se pueden comparar', async () => {
  for (const embeddingModel of ['text-embedding-ada-002', '', undefined]) {
    llamadasEmbedding.length = 0;
    const r = await saveNormalizedArticle(notaConVector({ embeddingModel }));
    assert.equal(r.embeddingReused, false, String(embeddingModel));
    assert.equal(llamadasEmbedding.length, 1, String(embeddingModel));
    assert.equal(creadas.at(-1).embeddingModel, EMBEDDING_MODEL);
  }
});

test('sin el texto con que se calculó el vector no hay manera de saber si sigue valiendo: se calcula', async () => {
  for (const embeddingText of [undefined, '', '   ']) {
    llamadasEmbedding.length = 0;
    const r = await saveNormalizedArticle(notaConVector({ embeddingText }));
    assert.equal(r.embeddingReused, false, JSON.stringify(embeddingText));
    assert.equal(llamadasEmbedding.length, 1, JSON.stringify(embeddingText));
  }
});

test('una nota sin nada de texto no se guarda con un vector viejo: sin texto no hay embedding', async () => {
  const vacia = notaConVector({ title: '', rawSummary: '', tags: [], embeddingText: '' });
  const r = await saveNormalizedArticle(vacia);

  assert.deepEqual([r.status, r.reason], ['skipped', 'embedding_failed']);
  assert.equal(creadas.length, 0);
});

test('si hay que recalcular y OpenAI falla, la nota se omite (como siempre) en vez de guardarse sin vector', async () => {
  respuestaEmbedding = async () => { throw new Error('OpenAI caído'); };
  const nota = notaConVector();
  nota.tags = ['otro'];
  const r = await saveNormalizedArticle(nota);

  assert.deepEqual([r.status, r.reason], ['skipped', 'embedding_failed']);
  assert.equal(llamadasEmbedding.length, 1);
  assert.equal(creadas.length, 0);
});

// ================================================================ lo de antes del vector no cambia
test('sin url, o con la url ya guardada, no se gasta ninguna llamada', async () => {
  assert.deepEqual(await saveNormalizedArticle({ title: 'Sin url' }), { status: 'skipped', reason: 'missing_url' });

  yaGuardada = { _id: 'vieja', url: 'https://medio.test/nota-1' };
  const r = await saveNormalizedArticle(notaConVector());
  assert.deepEqual([r.status, r.reason], ['skipped', 'duplicate_url']);
  assert.equal(llamadasEmbedding.length, 0);
  assert.equal(busquedasVectoriales.length, 0);
  assert.equal(creadas.length, 0);
});
