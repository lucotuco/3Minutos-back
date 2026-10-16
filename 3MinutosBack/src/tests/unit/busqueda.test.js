'use strict';

/**
 * Búsqueda híbrida (searchArticlesBySimilarityAtlas) con Atlas y OpenAI FALSOS.
 * Se comprueba lo que se le pide a Atlas (pipelines, filtros, campos), el timeout del embedding de la
 * consulta, la fusión por posición (RRF) y que el orden sea siempre el mismo con los mismos datos.
 * Correr:  npm run test:unit
 */

// Los módulos de búsqueda cargan config/openai, que exige las claves al importarse.
process.env.OPENAI_API_KEY_EMBEDDINGS ||= 'test';
process.env.OPENAI_API_KEY_REVIEW ||= 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { openaiEmbeddings } = require('../../config/openai');
const Article = require('../../models/Article');
const {
  searchArticlesBySimilarityAtlas, generateQueryEmbedding, createQueryEmbeddingCache, queryEmbeddings,
  QUERY_EMBEDDING_CACHE_TTL_MS, QUERY_EMBEDDING_CACHE_MAX_ENTRIES,
} = require('../../embeddings/searchArticlesBySimilarityAtlas');

// ---------------------------------------------------------------- falsos
const embeddingsPedidos = [];
let respuestaEmbedding;
openaiEmbeddings.embeddings.create = async (body, opciones) => {
  embeddingsPedidos.push({ body, opciones });
  return respuestaEmbedding;
};

const pipelines = [];
let vectorial = [];
let lexica = [];
Article.aggregate = async (pipeline) => {
  pipelines.push(pipeline);
  const primero = pipeline[0] || {};
  if (primero.$vectorSearch) return vectorial.map((d) => ({ ...d }));
  if (primero.$search) return lexica.map((d) => ({ ...d }));
  return [];
};

test.beforeEach(() => {
  queryEmbeddings.clear(); // cada test empieza sin vectores en la caché de consultas
  embeddingsPedidos.length = 0;
  pipelines.length = 0;
  vectorial = [];
  lexica = [];
  respuestaEmbedding = { data: [{ embedding: [0.1, 0.2, 0.3] }] };
});

const AHORA = new Date();
// Todas con la misma importancia y fecha: el puntaje final depende solo de la posición en las listas.
const doc = (id, extra = {}) => ({ _id: id, title: `Nota ${id}`, url: `https://m.test/${id}`, importanceScore: 60, publishedAt: AHORA, category: 'Deportes', ...extra });
const ids = (r) => r.map((d) => d._id);

// ================================================================ embedding de la consulta
test('generateQueryEmbedding: pide el modelo de embeddings con timeout de 8 s y un solo reintento', async () => {
  const v = await generateQueryEmbedding('  river plate  ');
  assert.deepEqual(v, [0.1, 0.2, 0.3]);
  assert.equal(embeddingsPedidos.length, 1);
  assert.deepEqual(embeddingsPedidos[0].body, { model: 'text-embedding-3-small', input: 'river plate' });
  assert.deepEqual(embeddingsPedidos[0].opciones, { timeout: 8000, maxRetries: 1 });
});

test('generateQueryEmbedding: texto vacío o respuesta inválida son errores (no se manda nada a la búsqueda)', async () => {
  await assert.rejects(() => generateQueryEmbedding('   '), /Missing query text/);
  await assert.rejects(() => generateQueryEmbedding(null), /Missing query text/);
  assert.equal(embeddingsPedidos.length, 0, 'con texto vacío ni siquiera se llama a OpenAI');
  respuestaEmbedding = { data: [] };
  await assert.rejects(() => generateQueryEmbedding('algo'), /Invalid query embedding response/);
  respuestaEmbedding = { data: [{ embedding: [] }] };
  await assert.rejects(() => generateQueryEmbedding('algo'), /Invalid query embedding response/);
});

// ================================================================ caché del embedding de la consulta
/** Una caché con un "OpenAI" falso que cuenta las llamadas y un reloj que se mueve a mano. */
function cacheFalsa({ ttlMs = 1000, maxEntries = 3, falla = null } = {}) {
  const llamadas = [];
  let ahora = 1_000_000;
  const cache = createQueryEmbeddingCache({
    ttlMs,
    maxEntries,
    now: () => ahora,
    fetch: async (texto) => {
      llamadas.push(texto);
      if (!String(texto || '').trim()) throw new Error('Missing query text'); // como el cálculo real
      await new Promise((resolve) => setImmediate(resolve));
      if (falla && llamadas.length <= falla) throw new Error('OpenAI caído');
      return [llamadas.length, texto.length];
    },
  });
  return { cache, llamadas, avanzar: (ms) => { ahora += ms; } };
}

test('caché de consultas: el mismo texto se calcula una sola vez (sin importar los espacios de los bordes)', async () => {
  const { cache, llamadas } = cacheFalsa();
  const a = await cache.get('river plate millonarios');
  const b = await cache.get('  river plate millonarios ');
  assert.deepEqual(llamadas, ['river plate millonarios']);
  assert.equal(b, a, 'es el mismo vector (el de la caché)');
  assert.deepEqual(a, [1, 23]);
});

test('caché de consultas: textos distintos son vectores distintos (también si solo cambian las mayúsculas)', async () => {
  const { cache, llamadas } = cacheFalsa();
  await cache.get('river plate');
  await cache.get('River Plate');
  await cache.get('boca');
  assert.deepEqual(llamadas, ['river plate', 'River Plate', 'boca']);
});

test('caché de consultas: pedidos simultáneos del mismo texto comparten UNA llamada', async () => {
  const { cache, llamadas } = cacheFalsa();
  const [x, y, z] = await Promise.all([cache.get('milei'), cache.get('milei '), cache.get(' milei')]);
  assert.deepEqual(llamadas, ['milei']);
  assert.equal(x, y);
  assert.equal(y, z);
  assert.equal(cache.inflight.size, 0, 'no queda nada en vuelo');
});

test('caché de consultas: un fallo no se guarda ni se queda pegado: el próximo pedido vuelve a intentar', async () => {
  const { cache, llamadas } = cacheFalsa({ falla: 1 });
  const juntos = await Promise.allSettled([cache.get('milei'), cache.get('milei')]);
  assert.deepEqual(juntos.map((r) => r.status), ['rejected', 'rejected'], 'los que compartían la llamada comparten el fallo');
  assert.equal(llamadas.length, 1);
  assert.equal(cache.inflight.size, 0);

  const v = await cache.get('milei');
  assert.deepEqual(v, [2, 5]);
  assert.equal(llamadas.length, 2);
  await cache.get('milei');
  assert.equal(llamadas.length, 2, 'ahora sí queda guardado');
});

test('caché de consultas: vence (el vector no cambia, pero la memoria no puede crecer sin límite)', async () => {
  const { cache, llamadas, avanzar } = cacheFalsa({ ttlMs: 1000 });
  await cache.get('milei');
  avanzar(999);
  await cache.get('milei');
  assert.equal(llamadas.length, 1, 'a 999 ms sigue valiendo');
  avanzar(1);
  await cache.get('milei');
  assert.equal(llamadas.length, 2, 'a 1000 ms venció');
});

test('caché de consultas: con el tope lleno se descarta la menos usada', async () => {
  const { cache, llamadas } = cacheFalsa({ maxEntries: 2 });
  await cache.get('a');
  await cache.get('b');
  await cache.get('a'); // a es la más reciente
  await cache.get('c'); // se descarta b
  assert.deepEqual(llamadas, ['a', 'b', 'c']);
  await cache.get('a');
  assert.equal(llamadas.length, 3, 'a sigue');
  await cache.get('b');
  assert.deepEqual(llamadas, ['a', 'b', 'c', 'b'], 'b se tuvo que volver a calcular');
});

test('caché de consultas: sin texto falla como siempre y no guarda nada', async () => {
  const { cache, llamadas } = cacheFalsa();
  for (const vacio of ['', '   ', null, undefined]) await assert.rejects(() => cache.get(vacio), /Missing query text/);
  assert.equal(llamadas.length, 4, 'se le pasa al cálculo tal cual (que es el que rechaza el texto vacío)');
  assert.equal(cache.cache.size, 0);

  await assert.rejects(() => queryEmbeddings.get('   '), /Missing query text/);
  assert.equal(embeddingsPedidos.length, 0);
});

test('caché de consultas: los valores de fábrica y clear()', async () => {
  assert.equal(QUERY_EMBEDDING_CACHE_TTL_MS, 6 * 3600e3);
  assert.equal(QUERY_EMBEDDING_CACHE_MAX_ENTRIES, 500);
  assert.equal(queryEmbeddings.cache.ttlMs, QUERY_EMBEDDING_CACHE_TTL_MS);
  assert.equal(queryEmbeddings.cache.maxEntries, QUERY_EMBEDDING_CACHE_MAX_ENTRIES);

  const { cache, llamadas } = cacheFalsa();
  await cache.get('a');
  cache.clear();
  await cache.get('a');
  assert.equal(llamadas.length, 2);
});

test('búsqueda: dos búsquedas con la misma consulta expandida piden UN embedding (las dos van a Atlas)', async () => {
  await searchArticlesBySimilarityAtlas('river plate', 'river plate millonarios');
  await searchArticlesBySimilarityAtlas('river', 'river plate millonarios', { category: 'Deportes' });
  assert.equal(embeddingsPedidos.length, 1);
  assert.equal(pipelines.length, 4, 'cada búsqueda consulta los dos motores');
  assert.deepEqual(pipelines.filter((p) => p[0].$vectorSearch).map((p) => p[0].$vectorSearch.queryVector), [[0.1, 0.2, 0.3], [0.1, 0.2, 0.3]]);

  await searchArticlesBySimilarityAtlas('boca', 'boca bombonera');
  assert.equal(embeddingsPedidos.length, 2, 'otra consulta, otro embedding');
});

test('búsqueda: si el embedding falla la búsqueda falla, y el próximo intento lo vuelve a pedir', async () => {
  respuestaEmbedding = { data: [] };
  await assert.rejects(() => searchArticlesBySimilarityAtlas('river', 'river club'), /Invalid query embedding response/);
  assert.equal(pipelines.length, 0, 'sin vector no se consulta Atlas');

  respuestaEmbedding = { data: [{ embedding: [0.5, 0.5] }] };
  await searchArticlesBySimilarityAtlas('river', 'river club');
  assert.equal(embeddingsPedidos.length, 2);
  assert.deepEqual(pipelines.find((p) => p[0].$vectorSearch)[0].$vectorSearch.queryVector, [0.5, 0.5]);
});

// ================================================================ pipelines
test('pipelines: el vector sale de la consulta EXPANDIDA y el texto de la EXACTA; los dos con los mismos filtros', async () => {
  const desde = new Date('2026-10-14T15:00:00.000Z');
  await searchArticlesBySimilarityAtlas('river plate', 'river plate millonarios', { limit: 5, minDate: desde, category: 'Deportes' });

  assert.equal(embeddingsPedidos[0].body.input, 'river plate millonarios');
  assert.equal(pipelines.length, 2);
  const vec = pipelines.find((p) => p[0].$vectorSearch);
  const txt = pipelines.find((p) => p[0].$search);

  const esperadoFiltro = { category: 'Deportes', publishedAt: { $gte: desde } };
  assert.equal(vec[0].$vectorSearch.index, 'articles_embedding_index');
  assert.equal(vec[0].$vectorSearch.path, 'embedding');
  assert.deepEqual(vec[0].$vectorSearch.queryVector, [0.1, 0.2, 0.3]);
  assert.equal(vec[0].$vectorSearch.numCandidates, 200);
  assert.equal(vec[0].$vectorSearch.limit, 50);
  assert.deepEqual(vec[0].$vectorSearch.filter, esperadoFiltro);

  assert.equal(txt[0].$search.index, 'articles_hybrid_index');
  assert.deepEqual(txt[0].$search.text, { query: 'river plate', path: ['title', 'tags', 'rawSummary'] });
  assert.deepEqual(txt[1], { $match: esperadoFiltro });
  assert.deepEqual(txt[2], { $limit: 50 });
});

test('pipelines: sin filtros no se manda filter al vector y el $match del texto va vacío', async () => {
  await searchArticlesBySimilarityAtlas('milei', 'milei gobierno');
  const vec = pipelines.find((p) => p[0].$vectorSearch);
  const txt = pipelines.find((p) => p[0].$search);
  assert.ok(!('filter' in vec[0].$vectorSearch));
  assert.deepEqual(txt[1], { $match: {} });
});

test('pipelines: minDate puede venir como Date o como texto, y section/region también filtran', async () => {
  await searchArticlesBySimilarityAtlas('x y', 'x y z', { minDate: '2026-10-14T15:00:00.000Z', section: 'deportes', region: 'Argentina' });
  const vec = pipelines.find((p) => p[0].$vectorSearch);
  assert.deepEqual(vec[0].$vectorSearch.filter, { section: 'deportes', region: 'Argentina', publishedAt: { $gte: new Date('2026-10-14T15:00:00.000Z') } });
});

test('proyección: trae los campos que mira la elegibilidad (geoScope, importancia, fecha, categoría, tópico…) y no el vector', async () => {
  await searchArticlesBySimilarityAtlas('river', 'river club');
  for (const p of pipelines) {
    const proyeccion = p.find((etapa) => etapa.$project).$project;
    for (const campo of ['_id', 'title', 'url', 'publishedAt', 'importanceScore', 'category', 'topic', 'geoScope', 'contentType', 'section', 'tags', 'sourceName',
      'neutralTitle', 'neutralLead', 'neutralSummary', 'rawSummary', 'contentSnippet', 'imageUrl', 'curationStatus']) {
      assert.equal(proyeccion[campo], 1, `falta ${campo} en la proyección`);
    }
    assert.ok(!('embedding' in proyeccion), 'la búsqueda no trae el embedding de las notas');
  }
  const vec = pipelines.find((p) => p[0].$vectorSearch);
  const txt = pipelines.find((p) => p[0].$search);
  assert.deepEqual(vec[1].$project.vectorScore, { $meta: 'vectorSearchScore' });
  assert.deepEqual(txt[3].$project.textScore, { $meta: 'searchScore' });
});

// ================================================================ fusión y orden
test('fusión: la nota que aparece primera en las dos listas vale 1; las que están en una sola lista valen (1/62)/(2/61)', async () => {
  vectorial = [doc('a'), doc('b')];
  lexica = [doc('a'), doc('c')];
  const r = await searchArticlesBySimilarityAtlas('x', 'x y');
  assert.deepEqual(ids(r), ['a', 'b', 'c']);
  assert.equal(r[0].score, 1);
  const medio = (1 / 62) / (2 / 61);
  assert.ok(Math.abs(r[1].score - medio) < 1e-12);
  assert.ok(Math.abs(r[2].score - medio) < 1e-12);
  assert.ok(r.every((d) => typeof d.finalScore === 'number'));
});

test('límite: devuelve como mucho `limit` notas (por defecto 20)', async () => {
  vectorial = Array.from({ length: 30 }, (_, i) => doc(`n${String(i).padStart(2, '0')}`));
  assert.equal((await searchArticlesBySimilarityAtlas('x', 'x y', { limit: 3 })).length, 3);
  assert.equal((await searchArticlesBySimilarityAtlas('x', 'x y')).length, 20);
});

test('orden estable: con puntajes empatados manda el _id, sin importar el orden en que llegaron las listas', async () => {
  // x e y tienen exactamente el mismo puntaje (uno es 1.º en una lista y 2.º en la otra, y al revés).
  vectorial = [doc('y'), doc('x')];
  lexica = [doc('x'), doc('y')];
  const r1 = await searchArticlesBySimilarityAtlas('q', 'q w');

  vectorial = [doc('x'), doc('y')];
  lexica = [doc('y'), doc('x')];
  const r2 = await searchArticlesBySimilarityAtlas('q', 'q w');

  assert.deepEqual(ids(r1), ['x', 'y']);
  assert.deepEqual(ids(r2), ['x', 'y']);
});

test('orden estable: la misma consulta con los mismos datos devuelve siempre lo mismo', async () => {
  vectorial = ['m', 'k', 'z', 'a'].map((id) => doc(id));
  lexica = ['z', 'm'].map((id) => doc(id));
  const corridas = [];
  for (let i = 0; i < 5; i++) corridas.push(ids(await searchArticlesBySimilarityAtlas('q', 'q w')).join(','));
  assert.equal(new Set(corridas).size, 1);
});

test('si Atlas falla la búsqueda falla (el motor lo trata como error_busqueda y sigue con el rescate)', async () => {
  const original = Article.aggregate;
  Article.aggregate = async () => { throw new Error('Atlas Search index "articles_hybrid_index" not found'); };
  try {
    await assert.rejects(() => searchArticlesBySimilarityAtlas('x', 'x y'), /articles_hybrid_index/);
  } finally {
    Article.aggregate = original;
  }
});
