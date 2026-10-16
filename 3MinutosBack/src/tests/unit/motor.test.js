'use strict';

/**
 * Tests del motor de elección (pickBestArticlePerTopic) con Mongo y OpenAI FALSOS.
 * Cubren los dos caminos (tema oficial por etiqueta / tema libre con búsqueda), la elegibilidad
 * aplicada en ambos, el historial, "la misma historia", el rescate y el orden determinista.
 * Correr:  npm run test:unit
 */

// Los módulos de búsqueda cargan config/openai, que exige las claves al importarse.
process.env.OPENAI_API_KEY_EMBEDDINGS ||= 'test';
process.env.OPENAI_API_KEY_REVIEW ||= 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { pickBestArticlePerTopic } = require('../../utils/pickBestArticlePerTopic');

// El motor loguea mucho; en los tests no aporta.
test.before(() => {
  for (const m of ['log', 'warn', 'error']) console[m] = () => {};
});

const NOW = Date.parse('2026-10-15T15:00:00.000Z');
const hace = (horas) => new Date(NOW - horas * 3600e3);

// ---------------------------------------------------------------- datos falsos
let seq = 0;
/** Embedding "único": un 1 en una posición distinta por nota (nunca se parece a otra). */
const unico = (i) => Array.from({ length: 512 }, (_, k) => (k === i % 512 ? 1 : 0));
/** Vector 2D cuyo coseno con [1, 0] es exactamente c. */
const conCoseno = (c) => [c, Math.sqrt(1 - c * c)];

function nota(extra = {}) {
  const i = seq++;
  return {
    _id: `n${String(i).padStart(4, '0')}`,
    url: `https://medio.test/nota-${i}`,
    title: `Nota ${i} sobre un hecho concreto`,
    publishedAt: hace(3),
    importanceScore: 60,
    category: 'Deportes',
    topic: 'Fútbol',
    geoScope: 'Argentina',
    section: 'deportes',
    tags: [],
    sourceName: 'Medio',
    rawSummary: 'resumen de la nota',
    embedding: unico(i),
    ...extra,
  };
}

/** Store falso: imita articleStore.js (lectura liviana, documentos completos, embeddings). */
function storeFalso(docs, { ignorarDesde = false, ignorarImportancia = false, falla = null } = {}) {
  const llamadas = { list: [], full: [], emb: [] };
  const liviano = (d) => {
    const { embedding, rawSummary, ...resto } = d; // eslint-disable-line no-unused-vars
    return resto;
  };
  return {
    llamadas,
    async listCandidates(q) {
      llamadas.list.push(q);
      if (falla) throw new Error(falla);
      return docs
        .filter((d) => (ignorarDesde || d.publishedAt >= q.since)
          && (ignorarImportancia || d.importanceScore >= q.minImportance)
          && (!q.category || d.category === q.category)
          && (!q.topic || d.topic === q.topic)
          && (!q.excludeTopic || d.topic !== q.excludeTopic))
        .sort((a, b) => b.publishedAt - a.publishedAt || (a._id < b._id ? -1 : 1))
        .map(liviano);
    },
    async loadFull(ids) {
      llamadas.full.push(ids.map(String));
      const quiero = new Set(ids.map(String));
      return new Map(docs.filter((d) => quiero.has(String(d._id))).map((d) => [String(d._id), { ...d }]));
    },
    async loadEmbeddings(ids) {
      llamadas.emb.push(ids.map(String));
      const quiero = new Set(ids.map(String));
      return new Map(docs.filter((d) => quiero.has(String(d._id)) && d.embedding?.length).map((d) => [String(d._id), d.embedding]));
    },
  };
}

/** Búsqueda falsa: devuelve `respuestas[n]` en la n-ésima llamada (o la última) y anota los argumentos. */
function busquedaFalsa(...respuestas) {
  const llamadas = [];
  const fn = async (exacta, vectorial, opts) => {
    llamadas.push({ exacta, vectorial, opts });
    const r = respuestas[Math.min(llamadas.length - 1, respuestas.length - 1)];
    if (r instanceof Error) throw r;
    return (r || []).map((d) => ({ ...d }));
  };
  fn.llamadas = llamadas;
  return fn;
}

function expansionFalsa() {
  const llamadas = [];
  const fn = async (t) => { llamadas.push(t); return `${t} expandido`; };
  fn.llamadas = llamadas;
  return fn;
}

async function correr(topics, { docs = [], busqueda = busquedaFalsa([]), historial = [], vistos = [], store = null, perTopicLimit = 10 } = {}) {
  const st = store || storeFalso(docs);
  const expand = expansionFalsa();
  const resultados = await pickBestArticlePerTopic(topics, {
    perTopicLimit,
    alreadyShownUrls: historial,
    seenEmbeddings: vistos,
    now: NOW,
    deps: { search: busqueda, expand, store: st },
  });
  return { resultados, store: st, expand, busqueda };
}

const urls = (r) => r.resultados.map((x) => x.article?.url ?? null);

// ================================================================ TEMAS OFICIALES

test('oficial (subtema): elige por etiqueta, sin búsqueda por significado ni expansión con IA', async () => {
  const a = nota({ publishedAt: hace(5), importanceScore: 60 });
  const b = nota({ publishedAt: hace(3), importanceScore: 55 });
  const otroSubtema = nota({ topic: 'Tenis', importanceScore: 99, publishedAt: hace(1) });
  const r = await correr(['Fútbol'], { docs: [b, a, otroSubtema] });

  assert.equal(r.resultados.length, 1);
  const x = r.resultados[0];
  assert.equal(x.article.url, a.url, 'misma banda (<= 10 h): gana la más importante');
  assert.equal(x.topic, 'Fútbol');
  assert.equal(x.matchZone, 'ETIQUETA');
  assert.equal(x.tier, 'buena');
  assert.equal(x.ageHours, 5);
  assert.equal(x.usedFallback, false);
  assert.equal(x.fallbackCategory, null);
  assert.equal(x.matchScore, null);
  assert.equal(x.corralCategory, 'Deportes');
  assert.match(x.matchReason, /^ETIQUETA buena 5h imp=60/);
  assert.equal(r.busqueda.llamadas.length, 0, 'no se busca por significado');
  assert.equal(r.expand.llamadas.length, 0, 'no se expande con IA');
  assert.equal(x.article.embedding, undefined, 'el embedding no viaja en el resultado');
  assert.equal(x.article.rawSummary, 'resumen de la nota', 'sí viene el documento completo');
});

test('oficial: no importan las mayúsculas ni las tildes; queryExpanded es lo que escribió el usuario', async () => {
  const a = nota();
  const r = await correr(['futbol'], { docs: [a] });
  assert.equal(r.resultados[0].topic, 'Fútbol');
  assert.equal(r.resultados[0].queryExpanded, 'futbol');
  assert.equal(r.resultados[0].article.url, a.url);
});

test('oficial: una nota de la banda ideal (<= 10 h) le gana a una más importante de 10-24 h', async () => {
  const ideal = nota({ publishedAt: hace(9), importanceScore: 50 });
  const valida = nota({ publishedAt: hace(15), importanceScore: 95 });
  const r = await correr(['Fútbol'], { docs: [valida, ideal] });
  assert.equal(r.resultados[0].article.url, ideal.url);
  assert.equal(r.resultados[0].tier, 'buena');
});

test('oficial: una buena de 20 h le gana a una aceptable (40-49) de 1 h', async () => {
  const aceptable = nota({ publishedAt: hace(1), importanceScore: 49 });
  const buena = nota({ publishedAt: hace(20), importanceScore: 50 });
  const r = await correr(['Fútbol'], { docs: [aceptable, buena] });
  assert.equal(r.resultados[0].article.url, buena.url);
  assert.equal(r.resultados[0].tier, 'buena');
});

test('oficial: sin buenas, entrega una aceptable y lo dice (tier aceptable, sin rescate)', async () => {
  const aceptable = nota({ publishedAt: hace(2), importanceScore: 45 });
  const r = await correr(['Fútbol'], { docs: [aceptable] });
  const x = r.resultados[0];
  assert.equal(x.article.url, aceptable.url);
  assert.equal(x.tier, 'aceptable');
  assert.equal(x.usedFallback, false);
});

test('oficial: nunca entrega una nota de más de 24 h ni de importancia < 40, aunque el store las devuelva', async () => {
  const vieja = nota({ publishedAt: hace(25), importanceScore: 90 });
  const floja = nota({ publishedAt: hace(1), importanceScore: 39 });
  const r = await correr(['Fútbol'], { store: storeFalso([vieja, floja], { ignorarDesde: true }) });
  assert.equal(r.resultados[0].article, null);
  assert.equal(r.resultados[0].matchReason, 'ningun_candidato_valido', 'había una nota, pero vencida');
});

test('oficial: 24 h justas valen; la lectura pide solo lo de las últimas 24 h', async () => {
  const justa = nota({ publishedAt: hace(24), importanceScore: 70 });
  const r = await correr(['Fútbol'], { docs: [justa] });
  assert.equal(r.resultados[0].article.url, justa.url);
  const consulta = r.store.llamadas.list[0];
  assert.equal(consulta.since.getTime(), NOW - 24 * 3600e3);
  assert.equal(consulta.minImportance, 40);
  assert.equal(consulta.topic, 'Fútbol');
  assert.equal(consulta.category, 'Deportes');
});

test('oficial: las URLs del historial se saltean y se pasa a la siguiente', async () => {
  const primera = nota({ publishedAt: hace(2), importanceScore: 90 });
  const segunda = nota({ publishedAt: hace(4), importanceScore: 70 });
  const r = await correr(['Fútbol'], { docs: [primera, segunda], historial: [primera.url] });
  assert.equal(r.resultados[0].article.url, segunda.url);
});

test('oficial: "la misma historia" que algo visto (coseno >= 0,88) se saltea; 0,879 no', async () => {
  const repetida = nota({ publishedAt: hace(1), importanceScore: 90, embedding: conCoseno(0.9) });
  const distinta = nota({ publishedAt: hace(5), importanceScore: 60, embedding: conCoseno(0.2) });
  const vistos = [{ title: 'Lo que ya vio', vector: [1, 0] }];

  const r1 = await correr(['Fútbol'], { docs: [repetida, distinta], vistos });
  assert.equal(r1.resultados[0].article.url, distinta.url);

  const casi = nota({ publishedAt: hace(1), importanceScore: 90, embedding: conCoseno(0.879) });
  const r2 = await correr(['Fútbol'], { docs: [casi, distinta], vistos });
  assert.equal(r2.resultados[0].article.url, casi.url, '0,879 todavía es otra historia');
});

test('oficial: con historial se trae el documento completo de varios finalistas por vez (no de a uno)', async () => {
  const docs = [nota({ publishedAt: hace(1), embedding: conCoseno(0.95) }), nota({ publishedAt: hace(2), embedding: conCoseno(0.95) }), nota({ publishedAt: hace(3), embedding: conCoseno(0.1) })];
  const r = await correr(['Fútbol'], { docs, vistos: [{ title: 'x', vector: [1, 0] }] });
  assert.equal(r.resultados[0].article.url, docs[2].url);
  assert.equal(r.store.llamadas.full.length, 1, 'una sola consulta para los tres finalistas');
  assert.equal(r.store.llamadas.full[0].length, 3);
});

test('oficial: sin historial ni notas ya elegidas alcanza con traer la primera', async () => {
  const docs = [nota({ publishedAt: hace(1) }), nota({ publishedAt: hace(2) }), nota({ publishedAt: hace(3) })];
  const r = await correr(['Fútbol'], { docs });
  assert.equal(r.store.llamadas.full.length, 1);
  assert.equal(r.store.llamadas.full[0].length, 1);
});

test('oficial: si todo el primer lote (8) es la misma historia que algo visto, sigue con el lote siguiente', async () => {
  const repetidas = Array.from({ length: 8 }, (_, i) => nota({ importanceScore: 90, publishedAt: hace(1 + i * 0.1), embedding: conCoseno(0.95) }));
  const distinta = nota({ importanceScore: 55, publishedAt: hace(9), embedding: conCoseno(0.1) });
  const r = await correr(['Fútbol'], { docs: [...repetidas, distinta], vistos: [{ title: 'ya vista', vector: [1, 0] }] });
  assert.equal(r.resultados[0].article.url, distinta.url);
  assert.deepEqual(r.store.llamadas.full.map((l) => l.length), [8, 1], 'dos lotes: 8 finalistas y después el siguiente');
});

test('oficial: se rinde después de 32 finalistas (4 lotes de 8): mejor un hueco que traer cientos de documentos', async () => {
  const repetidas = Array.from({ length: 32 }, (_, i) => nota({ importanceScore: 90, publishedAt: hace(1 + i * 0.05), embedding: conCoseno(0.95) }));
  const lejana = nota({ importanceScore: 55, publishedAt: hace(9), embedding: conCoseno(0.1) });
  const r = await correr(['Fútbol'], { docs: [...repetidas, lejana], vistos: [{ title: 'ya vista', vector: [1, 0] }] });
  assert.equal(r.store.llamadas.full.length, 4, 'como mucho 4 lotes');
  assert.ok(r.store.llamadas.full.every((l) => l.length === 8));
  assert.equal(r.resultados[0].article, null, 'la 33.ª nota no se llega a mirar');
  assert.equal(r.resultados[0].matchReason, 'ningun_candidato_valido');
});

test('oficial: si la nota se borró entre la lectura liviana y la completa, se prueba con la siguiente', async () => {
  const a = nota({ publishedAt: hace(1), importanceScore: 90 });
  const b = nota({ publishedAt: hace(2), importanceScore: 80 });
  const store = storeFalso([a, b]);
  const original = store.loadFull;
  store.loadFull = async (ids) => {
    const m = await original(ids);
    m.delete(String(a._id));
    return m;
  };
  const r = await correr(['Fútbol'], { store });
  assert.equal(r.resultados[0].article.url, b.url);
});

test('oficial: si la 1.ª nota de la banda ideal es repetida, entra la 2.ª de la misma banda antes que una de 10-24 h', async () => {
  const repetida = nota({ publishedAt: hace(2), importanceScore: 80, embedding: conCoseno(0.95) });
  const ideal2 = nota({ publishedAt: hace(8), importanceScore: 60, embedding: conCoseno(0.1) });
  const valida = nota({ publishedAt: hace(15), importanceScore: 95, embedding: conCoseno(0.2) });
  const r = await correr(['Fútbol'], { docs: [valida, repetida, ideal2], vistos: [{ title: 'v', vector: [1, 0] }] });
  assert.equal(r.resultados[0].article.url, ideal2.url);
});

test('oficial: rescate = misma categoría, otro subtema, importancia >= 50, marcada como sugerida', async () => {
  const tenis = nota({ topic: 'Tenis', importanceScore: 70, publishedAt: hace(4) });
  const rugbyFlojo = nota({ topic: 'Rugby', importanceScore: 45, publishedAt: hace(1) }); // 40-49: no vale para el rescate
  const politica = nota({ category: 'Política', topic: 'Justicia', importanceScore: 99, publishedAt: hace(1) });
  const r = await correr(['Fútbol'], { docs: [rugbyFlojo, politica, tenis] });
  const x = r.resultados[0];
  assert.equal(x.article.url, tenis.url);
  assert.equal(x.usedFallback, true);
  assert.equal(x.fallbackCategory, 'Deportes');
  assert.equal(x.matchZone, 'RESCATE');
  assert.equal(x.tier, 'sugerida');
  assert.equal(x.matchReason, 'sin_candidatos');
  assert.equal(x.matchScore, null);
  assert.equal(x.corralCategory, 'Deportes');
});

test('oficial: el rescate usa matchReason "ningun_candidato_valido" si había notas pero ninguna servía', async () => {
  const yaVista = nota({ topic: 'Fútbol', importanceScore: 80, publishedAt: hace(2) });
  const tenis = nota({ topic: 'Tenis', importanceScore: 60, publishedAt: hace(3) });
  const r = await correr(['Fútbol'], { docs: [yaVista, tenis], historial: [yaVista.url] });
  assert.equal(r.resultados[0].usedFallback, true);
  assert.equal(r.resultados[0].matchReason, 'ningun_candidato_valido');
});

test('oficial: el rescate nunca sale de otra categoría; sin nada, el hueco queda vacío', async () => {
  const politica = nota({ category: 'Política', topic: 'Justicia', importanceScore: 99 });
  const r = await correr(['Fútbol'], { docs: [politica] });
  const x = r.resultados[0];
  assert.equal(x.article, null);
  assert.equal(x.usedFallback, false);
  assert.equal(x.matchZone, null);
  assert.equal(x.matchReason, 'sin_candidatos');
  assert.equal(x.tier, null);
  assert.equal(x.corralCategory, 'Deportes');
});

test('oficial: la lectura del rescate pide la categoría SIN el subtema, buenas (>= 50) y de las últimas 24 h', async () => {
  const tenis = nota({ topic: 'Tenis', importanceScore: 70, publishedAt: hace(4) });
  const r = await correr(['Fútbol'], { docs: [tenis] });
  assert.equal(r.store.llamadas.list.length, 2, 'una lectura del tema exacto y otra del rescate');
  const [exacta, rescate] = r.store.llamadas.list;
  assert.equal(exacta.category, 'Deportes');
  assert.equal(exacta.topic, 'Fútbol');
  assert.equal(exacta.minImportance, 40);
  assert.equal(exacta.since.getTime(), NOW - 24 * 3600e3);
  assert.equal(rescate.category, 'Deportes');
  assert.equal(rescate.excludeTopic, 'Fútbol');
  assert.ok(!rescate.topic, 'el rescate no pide un subtema en particular');
  assert.equal(rescate.minImportance, 50);
  assert.equal(rescate.since.getTime(), NOW - 24 * 3600e3);
});

test('oficial: el rescate vuelve a exigir nota "buena" aunque la lectura devuelva notas de 40-49', async () => {
  const tenisFlojo = nota({ topic: 'Tenis', importanceScore: 45, publishedAt: hace(1) });
  const store = storeFalso([tenisFlojo], { ignorarImportancia: true });
  const r = await correr(['Fútbol'], { store });
  assert.equal(r.resultados[0].article, null, 'una aceptable no sirve de rescate: mejor un hueco');
  assert.equal(r.resultados[0].usedFallback, false);
});

test('oficial (categoría): toma la mejor de toda la categoría y no tiene rescate', async () => {
  const futbol = nota({ topic: 'Fútbol', importanceScore: 60, publishedAt: hace(4) });
  const tenis = nota({ topic: 'Tenis', importanceScore: 85, publishedAt: hace(6) });
  const libre = nota({ topic: 'Ciclismo', importanceScore: 70, publishedAt: hace(5) }); // etiqueta suelta: también cuenta
  const r = await correr(['Deportes'], { docs: [futbol, tenis, libre] });
  assert.equal(r.resultados[0].article.url, tenis.url);
  assert.equal(r.resultados[0].topic, 'Deportes');
  assert.equal(r.store.llamadas.list.length, 1);
  assert.equal(r.store.llamadas.list[0].topic, null);

  const agotada = await correr(['Deportes'], { docs: [futbol], historial: [futbol.url] });
  assert.equal(agotada.resultados[0].article, null);
  assert.equal(agotada.resultados[0].usedFallback, false);
  assert.equal(agotada.store.llamadas.list.length, 1, 'una categoría no tiene rescate');
});

test('oficial: Sociedad solo entrega Argentina o Global; el resto del mundo queda afuera', async () => {
  const mexico = nota({ category: 'Sociedad', topic: 'Salud', geoScope: 'México', importanceScore: 90, publishedAt: hace(1) });
  const global = nota({ category: 'Sociedad', topic: 'Salud', geoScope: 'Global', importanceScore: 55, publishedAt: hace(20) });
  const r = await correr(['Salud'], { docs: [mexico, global] });
  assert.equal(r.resultados[0].article.url, global.url);

  const soloMexico = await correr(['Salud'], { docs: [mexico] });
  assert.equal(soloMexico.resultados[0].article, null);
});

test('oficial: opinión y previas/en vivo no se entregan', async () => {
  const columna = nota({ url: 'https://medio.test/opinion/x', importanceScore: 90 });
  const previa = nota({ title: 'Previa del clásico: cómo llegan', importanceScore: 90 });
  const envivo = nota({ title: 'EN VIVO | Boca - River', importanceScore: 90 });
  const buena = nota({ importanceScore: 51, publishedAt: hace(9) });
  const r = await correr(['Fútbol'], { docs: [columna, previa, envivo, buena] });
  assert.equal(r.resultados[0].article.url, buena.url);
});

test('oficial: tópicos que comparten notas no repiten URL ni historia dentro del digest', async () => {
  // `a` es [1, 0]; `b` tiene coseno 0,95 con `a` (misma historia) y `c` 0,4 (otra historia).
  const a = nota({ publishedAt: hace(1), importanceScore: 90, embedding: [1, 0] });
  const b = nota({ publishedAt: hace(2), importanceScore: 80, embedding: conCoseno(0.95) });
  const c = nota({ publishedAt: hace(3), importanceScore: 70, embedding: conCoseno(0.4) });
  const r = await correr(['Deportes', 'Fútbol'], { docs: [a, b, c] });
  assert.equal(r.resultados[0].article.url, a.url);
  assert.equal(r.resultados[1].article.url, c.url, 'la 2.ª nota es la misma historia que la 1.ª: sigue la 3.ª');
  assert.equal(new Set(urls(r)).size, 2);
});

test('oficial: una nota sin embedding tampoco se repite entre tópicos (la frena la URL)', async () => {
  const sola = nota({ publishedAt: hace(2), importanceScore: 80, embedding: [] });
  const r = await correr(['Deportes', 'Fútbol'], { docs: [sola] });
  assert.equal(r.resultados[0].article.url, sola.url);
  assert.equal(r.resultados[1].article, null, 'sin vector no se puede comparar la historia, pero la URL ya salió');
});

test('oficial: mismos datos, mismo resultado, sin importar el orden en que llegan las notas', async () => {
  const docs = [0, 1, 2, 3, 4, 5].map(() => nota({ publishedAt: hace(4), importanceScore: 70 })); // empate total
  const esperado = (await correr(['Fútbol'], { docs })).resultados[0].article.url;
  for (let i = 0; i < 5; i++) {
    const mezclados = [...docs].sort(() => Math.random() - 0.5);
    assert.equal((await correr(['Fútbol'], { docs: mezclados })).resultados[0].article.url, esperado);
  }
  assert.equal(esperado, [...docs].sort((x, y) => (x._id < y._id ? -1 : 1))[0].url, 'gana el _id menor');
});

test('oficial: si Mongo falla, ese tópico queda vacío con error_busqueda y los demás siguen', async () => {
  const libre = nota({ category: 'Tecnología', topic: 'Inteligencia Artificial', title: 'Nvidia presentó un chip', score: 0.97, importanceScore: 70 });
  const store = storeFalso([], { falla: 'se cayó Mongo' });
  const r = await correr(['Fútbol', 'nvidia'], { store, busqueda: busquedaFalsa([libre]) });
  assert.equal(r.resultados[0].article, null);
  assert.equal(r.resultados[0].matchReason, 'error_busqueda');
  assert.equal(r.resultados[1].article.url, libre.url);
});

test('tópicos vacíos o solo espacios se ignoran (y no desalinean los demás)', async () => {
  const a = nota();
  const r = await correr(['', '   ', 'Fútbol', null, undefined], { docs: [a] });
  assert.equal(r.resultados.length, 1);
  assert.equal(r.resultados[0].topic, 'Fútbol');
});

test('nombres de prototipo ("constructor", "__proto__") son tópicos libres, no oficiales', async () => {
  const r = await correr(['constructor', '__proto__', 'toString'], { busqueda: busquedaFalsa([]) });
  assert.equal(r.resultados.length, 3);
  assert.equal(r.store.llamadas.list.length, 0, 'ninguno se leyó como oficial');
  assert.deepEqual(r.expand.llamadas, ['constructor', '__proto__', 'toString']);
  for (const x of r.resultados) assert.equal(x.article, null);
});

// ================================================================ TEMAS LIBRES

/** Candidatos de "river plate": todos mencionan River (el pool deduce el ancla "river"). */
function candidatosRiver() {
  const base = { category: 'Deportes', topic: 'Fútbol', tags: [], rawSummary: '', contentSnippet: '' };
  return {
    verdeVieja: nota({ ...base, title: 'River ganó con un golazo de Colidio', score: 0.97, importanceScore: 55, publishedAt: hace(18) }),
    amarillaFresca: nota({ ...base, title: 'River prepara el equipo para el clásico', score: 0.86, importanceScore: 90, publishedAt: hace(1) }),
    amarilla2: nota({ ...base, title: 'River y el problema del arco', score: 0.84, importanceScore: 60, publishedAt: hace(6) }),
    amarilla3: nota({ ...base, title: 'River recupera a un titular', score: 0.82, importanceScore: 58, publishedAt: hace(7) }),
    roja: nota({ ...base, title: 'Iguazú cerrado por inundaciones', category: 'Sociedad', score: 0.5, importanceScore: 70, publishedAt: hace(1) }),
  };
}

test('libre: una sola expansión por tópico libre, ventana de 30 candidatos y filtro de 24 h en la búsqueda', async () => {
  const c = candidatosRiver();
  const r = await correr(['river plate', 'Fútbol'], {
    docs: [nota()],
    busqueda: busquedaFalsa([c.verdeVieja, c.amarillaFresca, c.amarilla2, c.amarilla3, c.roja]),
  });
  assert.deepEqual(r.expand.llamadas, ['river plate'], 'solo el libre se expande');
  const llamada = r.busqueda.llamadas[0];
  assert.equal(llamada.exacta, 'river plate');
  assert.equal(llamada.vectorial, 'river plate expandido');
  assert.equal(llamada.opts.limit, 30);
  assert.equal(llamada.opts.minDate.getTime(), NOW - 24 * 3600e3);
  assert.equal(r.resultados[0].queryExpanded, 'river plate expandido');
});

test('libre: la zona VERDE gana aunque la AMARILLA sea más nueva e importante', async () => {
  const c = candidatosRiver();
  const r = await correr(['river plate'], { busqueda: busquedaFalsa([c.amarillaFresca, c.verdeVieja, c.amarilla2, c.amarilla3, c.roja]) });
  const x = r.resultados[0];
  assert.equal(x.article.url, c.verdeVieja.url);
  assert.equal(x.matchZone, 'VERDE');
  assert.equal(x.matchScore, 0.97);
  assert.equal(x.tier, 'buena');
  assert.equal(x.usedFallback, false);
  assert.equal(x.candidatesEvaluated, 2, 'posición de la nota elegida en la lista de la búsqueda');
  assert.match(x.matchReason, /^VERDE score=0\.970 \(candidato #2\)/);
});

test('libre: sin VERDE, entre las AMARILLAS válidas manda la banda de edad y después la importancia', async () => {
  const c = candidatosRiver();
  const r = await correr(['river plate'], { busqueda: busquedaFalsa([c.amarilla3, c.amarilla2, c.amarillaFresca, c.roja]) });
  assert.equal(r.resultados[0].article.url, c.amarillaFresca.url, '1 h e importancia 90 (banda ideal)');
  assert.equal(r.resultados[0].matchZone, 'AMARILLA');
});

test('libre: la elegibilidad también aplica (vencida, floja, en vivo, opinión, Sociedad de otro país)', async () => {
  const c = candidatosRiver();
  const vencida = nota({ title: 'River vence a un rival', category: 'Deportes', score: 0.99, importanceScore: 90, publishedAt: hace(30) });
  const floja = nota({ title: 'River: dato menor', category: 'Deportes', score: 0.99, importanceScore: 20 });
  const vivo = nota({ title: 'River EN VIVO | minuto a minuto', category: 'Deportes', score: 0.99, importanceScore: 90 });
  const columna = nota({ title: 'River: una columna', url: 'https://medio.test/opinion/river', score: 0.99, importanceScore: 90 });
  const r = await correr(['river plate'], { busqueda: busquedaFalsa([vencida, floja, vivo, columna, c.verdeVieja, c.amarilla2, c.amarilla3]) });
  assert.equal(r.resultados[0].article.url, c.verdeVieja.url);
});

test('libre: lo ya visto (URL o misma historia) se saltea y se entrega la siguiente de calidad', async () => {
  const c = candidatosRiver();
  const repetida = { ...c.verdeVieja, embedding: conCoseno(0.95) };
  const otra = { ...c.amarillaFresca, embedding: conCoseno(0.1) };
  const vistos = [{ title: 'ya la vio', vector: [1, 0] }];

  const r1 = await correr(['river plate'], {
    docs: [repetida, otra],
    busqueda: busquedaFalsa([repetida, otra, c.amarilla2, c.amarilla3]),
    vistos,
  });
  assert.equal(r1.resultados[0].article.url, otra.url, 'la VERDE es la misma historia: sigue la AMARILLA');

  const r2 = await correr(['river plate'], {
    busqueda: busquedaFalsa([c.verdeVieja, c.amarillaFresca, c.amarilla2, c.amarilla3]),
    historial: [c.verdeVieja.url],
  });
  assert.equal(r2.resultados[0].article.url, c.amarillaFresca.url);
});

test('libre: sin ningún candidato válido hay rescate en el rubro, solo con notas buenas (>= 50)', async () => {
  const c = candidatosRiver();
  const rescateFloja = nota({ category: 'Deportes', title: 'Nota del rubro', importanceScore: 45, publishedAt: hace(1) });
  const rescateBuena = nota({ category: 'Deportes', title: 'Otra nota del rubro', importanceScore: 52, publishedAt: hace(5) });
  const sinTema = [c.roja]; // 1 candidato rojo: no hay tema ni corral
  const r = await correr(['river plate'], { busqueda: busquedaFalsa(sinTema, [rescateFloja, rescateBuena]) });
  const x = r.resultados[0];
  assert.equal(x.article.url, rescateBuena.url);
  assert.equal(x.usedFallback, true);
  assert.equal(x.matchZone, 'RESCATE');
  assert.equal(x.tier, 'sugerida');
  assert.equal(x.matchReason, 'ningun_candidato_valido');
  assert.equal(x.fallbackCategory, 'Deportes');

  const segunda = r.busqueda.llamadas[1];
  assert.equal(segunda.exacta, 'Sociedad Argentina actualidad nacional', 'sin corral inferido el rescate cae en Sociedad');
  assert.equal(segunda.opts.category, 'Sociedad');
  assert.equal(segunda.opts.minDate.getTime(), NOW - 24 * 3600e3);
});

test('libre: si el rescate solo tiene notas aceptables (40-49) queda el hueco', async () => {
  const c = candidatosRiver();
  const aceptable = nota({ category: 'Deportes', title: 'Nota del rubro', importanceScore: 45, publishedAt: hace(1) });
  const r = await correr(['river plate'], { busqueda: busquedaFalsa([c.roja], [aceptable]) });
  assert.equal(r.resultados[0].article, null, 'una aceptable no sirve de rescate: mejor un hueco');
  assert.equal(r.resultados[0].usedFallback, false);
  assert.equal(r.busqueda.llamadas.length, 2, 'se intentó el rescate');
});

test('libre: dos tópicos con los mismos candidatos y sin embeddings no repiten la nota (la frena la URL)', async () => {
  const c = candidatosRiver();
  const r = await correr(['river plate', 'river'], { busqueda: busquedaFalsa([c.verdeVieja, c.amarillaFresca, c.amarilla2, c.amarilla3]) });
  assert.ok(r.resultados[0].article && r.resultados[1].article, 'los dos tópicos entregan una nota');
  assert.notEqual(r.resultados[0].article.url, r.resultados[1].article.url);
});

test('libre: el rescate usa el corral que votaron los candidatos del propio tema', async () => {
  const c = candidatosRiver();
  const todasVistas = [c.verdeVieja, c.amarillaFresca, c.amarilla2, c.amarilla3];
  const rescate = nota({ category: 'Deportes', title: 'Algo del rubro', importanceScore: 60 });
  const r = await correr(['river plate'], {
    busqueda: busquedaFalsa(todasVistas, [rescate]),
    historial: todasVistas.map((a) => a.url),
  });
  assert.equal(r.busqueda.llamadas[1].exacta, 'Deportes Argentina actualidad nacional');
  assert.equal(r.busqueda.llamadas[1].opts.category, 'Deportes');
  assert.equal(r.resultados[0].article.url, rescate.url);
  assert.equal(r.resultados[0].corralCategory, 'Deportes');
});

test('libre: si la búsqueda falla se informa error_busqueda y se intenta el rescate', async () => {
  const rescate = nota({ category: 'Sociedad', topic: 'Salud', importanceScore: 60 });
  const r = await correr(['river plate'], { busqueda: busquedaFalsa(new Error('Atlas caído'), [rescate]) });
  assert.equal(r.resultados[0].matchReason, 'error_busqueda');
  assert.equal(r.resultados[0].usedFallback, true);
  assert.equal(r.resultados[0].article.url, rescate.url);

  const todoCaido = await correr(['river plate'], { busqueda: busquedaFalsa(new Error('caído')) });
  assert.equal(todoCaido.resultados[0].article, null);
  assert.equal(todoCaido.resultados[0].matchReason, 'error_busqueda');
  assert.equal(todoCaido.resultados[0].usedFallback, false);
});

test('libre: el rescate también respeta la elegibilidad (24 h, historial, país de Sociedad)', async () => {
  const vieja = nota({ category: 'Sociedad', importanceScore: 90, publishedAt: hace(40) });
  const extranjera = nota({ category: 'Sociedad', geoScope: 'Colombia', importanceScore: 90 });
  const vista = nota({ category: 'Sociedad', importanceScore: 90 });
  const buena = nota({ category: 'Sociedad', geoScope: 'Global', importanceScore: 51, publishedAt: hace(20) });
  const r = await correr(['qzxvbnm'], { busqueda: busquedaFalsa([], [vieja, extranjera, vista, buena]), historial: [vista.url] });
  assert.equal(r.resultados[0].article.url, buena.url);
});

test('mezcla: oficial y libre en un mismo digest, sin repetir nota', async () => {
  const c = candidatosRiver();
  const oficial = nota({ publishedAt: hace(2), importanceScore: 80 });
  const r = await correr(['Fútbol', 'river plate'], {
    docs: [oficial],
    busqueda: busquedaFalsa([c.verdeVieja, c.amarilla2, c.amarilla3]),
  });
  assert.equal(r.resultados[0].article.url, oficial.url);
  assert.equal(r.resultados[1].article.url, c.verdeVieja.url);
  assert.equal(new Set(urls(r)).size, 2);
});

test('la lista de tópicos vacía devuelve []', async () => {
  assert.deepEqual(await pickBestArticlePerTopic([], { now: NOW }), []);
  assert.deepEqual(await pickBestArticlePerTopic(undefined, { now: NOW }), []);
});
