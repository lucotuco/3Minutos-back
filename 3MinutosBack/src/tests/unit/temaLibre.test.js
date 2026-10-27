'use strict';

/**
 * Tests del camino de los temas LIBRES del motor (pickBestArticlePerTopic): la pista de categoría/subtema que devuelve
 * la expansión con IA, el juez de tema, el corral blando y las dos fases (primero todo lo que es de red, en paralelo;
 * después la elección en orden). Mongo, búsqueda, expansión e IA son FALSOS: ningún test llama a OpenAI.
 * Correr:  npm run test:unit
 */

// Los módulos de búsqueda cargan config/openai, que exige las claves al importarse.
process.env.OPENAI_API_KEY_EMBEDDINGS ||= 'test';
process.env.OPENAI_API_KEY_REVIEW ||= 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { pickBestArticlePerTopic } = require('../../utils/pickBestArticlePerTopic');
const { firstNotRepeated } = require('../../utils/officialPick');
const { createGate } = require('../../utils/concurrencyGate');
const { createTopicJudge, createTopicLlm } = require('../../utils/topicJudge');
const { createTopicExpander } = require('../../utils/topicExpansion');
const { judgeWaitBudgetMs } = require('../../utils/llmJudge');

test.before(() => {
  for (const m of ['log', 'warn', 'error']) console[m] = () => {};
});

const NOW = Date.parse('2026-10-15T15:00:00.000Z');
const hace = (horas) => new Date(NOW - horas * 3600e3);

// ---------------------------------------------------------------- datos falsos
let seq = 0;
const unico = (i) => Array.from({ length: 256 }, (_, k) => (k === i % 256 ? 1 : 0));
const conCoseno = (c) => [c, Math.sqrt(1 - c * c)];

/** Una nota que la búsqueda devuelve (con `score`); por defecto VERDE, de Deportes/Fútbol, de 3 h e importancia 60. */
function nota(extra = {}) {
  const i = seq++;
  return {
    _id: `l${String(i).padStart(4, '0')}`,
    url: `https://medio.test/l-${i}`,
    title: `Nota ${i} sobre un hecho concreto`,
    publishedAt: hace(3),
    importanceScore: 60,
    category: 'Deportes',
    topic: 'Fútbol',
    geoScope: 'Argentina',
    section: 'deportes',
    tags: [],
    sourceName: 'Medio',
    rawSummary: `resumen de la nota ${i}`,
    contentSnippet: '',
    embedding: unico(i),
    score: 0.96,
    ...extra,
  };
}

/** Store falso: lo que el motor lee de Mongo (etiquetas, documentos completos, embeddings). */
function storeFalso(docs = []) {
  const liviano = (d) => { const { embedding, rawSummary, ...resto } = d; return resto; }; // eslint-disable-line no-unused-vars
  return {
    async listCandidates(q) {
      return docs
        .filter((d) => d.publishedAt >= q.since && d.importanceScore >= q.minImportance
          && (!q.category || d.category === q.category) && (!q.topic || d.topic === q.topic) && (!q.excludeTopic || d.topic !== q.excludeTopic))
        .sort((a, b) => b.publishedAt - a.publishedAt || (a._id < b._id ? -1 : 1))
        .map(liviano);
    },
    async loadFull(ids) {
      const quiero = new Set(ids.map(String));
      return new Map(docs.filter((d) => quiero.has(String(d._id))).map((d) => [String(d._id), { ...d }]));
    },
    async loadEmbeddings(ids) {
      const quiero = new Set(ids.map(String));
      return new Map(docs.filter((d) => quiero.has(String(d._id)) && d.embedding?.length).map((d) => [String(d._id), d.embedding]));
    },
  };
}

/**
 * Búsqueda falsa. `responder` es un objeto { consulta exacta: notas | Error } o una función (exacta, vectorial, opts, n).
 * Anota cada llamada.
 */
function busquedaFalsa(responder = {}) {
  const llamadas = [];
  const fn = async (exacta, vectorial, opts) => {
    llamadas.push({ exacta, vectorial, opts });
    const r = typeof responder === 'function' ? await responder(exacta, vectorial, opts, llamadas.length) : responder[exacta];
    if (r instanceof Error) throw r;
    return (r || []).map((d) => ({ ...d }));
  };
  fn.llamadas = llamadas;
  return fn;
}

/** Expansión falsa: `responder(tema)` devuelve { q, cat, sub } (o un texto, o null) o lanza. Anota cada tema. */
function expansionFalsa(responder = (t) => ({ q: `${t} expandido`, cat: '', sub: '' })) {
  const llamadas = [];
  const fn = async (t) => { llamadas.push(t); return responder(t); };
  fn.llamadas = llamadas;
  return fn;
}

/**
 * Juez de tema falso, con la forma de createTopicJudge. `decide(tema, nota)` devuelve 'SI' | 'PARCIAL' | 'NO' | null
 * (sin veredicto) o un Error (el juez lanza). Anota todo en `registro`, en el orden en que pasó.
 */
function juezTemaFalso(decide, { activo = true } = {}) {
  const registro = { eventos: [], prefetch: [], preguntas: [] };
  return {
    registro,
    enabled: () => activo,
    prefetch(tema, n) {
      registro.prefetch.push({ tema, id: n.id, title: n.title });
      registro.eventos.push(['prefetch', tema, n.id]);
    },
    async verdictFor(tema, n) {
      registro.preguntas.push({ tema, id: n.id, title: n.title, lead: n.lead });
      registro.eventos.push(['pregunta', tema, n.id]);
      const v = decide(tema, n);
      if (v instanceof Error) throw v;
      return { verdict: v, source: v ? 'llm' : 'timeout', waitedMs: 0 };
    },
  };
}

/** decide() a partir de { id: veredicto }; lo que no figura recibe `porDefecto`. */
const porId = (mapa, porDefecto = 'SI') => (tema, n) => (n.id in mapa ? mapa[n.id] : porDefecto);

async function correr(topics, {
  docs = [], busqueda = busquedaFalsa(), expand = expansionFalsa(), juezTema = null, juez = null,
  historial = [], vistos = [], judgeWaitMs,
} = {}) {
  const resultados = await pickBestArticlePerTopic(topics, {
    alreadyShownUrls: historial,
    seenEmbeddings: vistos,
    now: NOW,
    judgeWaitMs,
    deps: { search: busqueda, expand, store: storeFalso(docs), judge: juez, topicJudge: juezTema },
  });
  return { resultados, busqueda, expand, juezTema };
}

/** Falla (en vez de colgarse) si `promesa` no termina en `ms`. */
function antesDe(ms, mensaje, promesa) {
  let timer;
  const limite = new Promise((_, rechazar) => { timer = setTimeout(() => rechazar(new Error(mensaje)), ms); });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(timer));
}

const urls = (r) => r.resultados.map((x) => x.article?.url ?? null);
const ids = (lista) => lista.map((x) => x.id);

// ================================================================ la pista de categoría/subtema
/** "boca": una nota de fútbol y una de tenis que también dice Boca (Boca Raton), la de tenis más nueva e importante. */
function futbolYTenis() {
  const futbol = nota({ title: 'Boca ganó en la Bombonera', topic: 'Fútbol', importanceScore: 60, publishedAt: hace(8) });
  const tenis = nota({ title: 'Boca Raton: final del torneo de tenis', topic: 'Tenis', importanceScore: 90, publishedAt: hace(1) });
  return { futbol, tenis };
}

test('la pista de la IA ordena: "boca" prefiere la nota de Fútbol aunque la de Tenis sea más nueva e importante', async () => {
  const { futbol, tenis } = futbolYTenis();
  const expand = expansionFalsa(() => ({ q: 'boca juniors bombonera xeneize', cat: 'Deportes', sub: 'Fútbol' }));
  const r = await correr(['boca'], { expand, busqueda: busquedaFalsa({ boca: [tenis, futbol] }) });

  assert.equal(r.resultados[0].article.url, futbol.url);
  assert.equal(r.resultados[0].queryExpanded, 'boca juniors bombonera xeneize');
  assert.equal(r.busqueda.llamadas[0].exacta, 'boca');
  assert.equal(r.busqueda.llamadas[0].vectorial, 'boca juniors bombonera xeneize');
});

test('la pista de categoría sola, o una equivocada, no cambia el orden entre notas de la misma categoría', async () => {
  const { futbol, tenis } = futbolYTenis();
  for (const pista of [{ cat: 'Deportes', sub: '' }, { cat: '', sub: '' }, { cat: 'Política', sub: '' }]) {
    const expand = expansionFalsa(() => ({ q: 'boca', ...pista }));
    const r = await correr(['boca'], { expand, busqueda: busquedaFalsa({ boca: [futbol, tenis] }) });
    assert.equal(r.resultados[0].article.url, tenis.url, `pista ${JSON.stringify(pista)}: gana la más nueva e importante`);
  }
});

test('la pista es un criterio de orden, nunca un filtro: si solo hay notas de otro subtema o categoría, se entrega una igual', async () => {
  const { tenis } = futbolYTenis();
  const expand = expansionFalsa(() => ({ q: 'boca juniors', cat: 'Deportes', sub: 'Fútbol' }));
  const r = await correr(['boca'], { expand, busqueda: busquedaFalsa({ boca: [tenis] }) });
  assert.equal(r.resultados[0].article.url, tenis.url, 'una nota de Tenis cuando la pista dice Fútbol');

  const otraCategoria = nota({ title: 'Boca de tormenta en el Conurbano', category: 'Sociedad', topic: 'Clima y Ambiente' });
  const r2 = await correr(['boca'], { expand, busqueda: busquedaFalsa({ boca: [otraCategoria] }) });
  assert.equal(r2.resultados[0].article.url, otraCategoria.url, 'y una de Sociedad');
});

test('el nivel de la nota va antes que la pista: una "buena" de otro subtema le gana a una "aceptable" del subtema', async () => {
  const aceptableFutbol = nota({ title: 'Boca: el once para mañana', topic: 'Fútbol', importanceScore: 45, publishedAt: hace(2) });
  const buenaTenis = nota({ title: 'Boca Raton: torneo de tenis', topic: 'Tenis', importanceScore: 60, publishedAt: hace(9) });
  const expand = expansionFalsa(() => ({ q: 'boca', cat: 'Deportes', sub: 'Fútbol' }));
  const r = await correr(['boca'], { expand, busqueda: busquedaFalsa({ boca: [aceptableFutbol, buenaTenis] }) });
  assert.equal(r.resultados[0].article.url, buenaTenis.url);
  assert.equal(r.resultados[0].tier, 'buena');
});

test('la pista va antes que el puntaje de importancia y frescura: dentro del mismo nivel, lo del subtema (aunque tenga 20 h) pasa antes que lo de 1 h de otro', async () => {
  const futbolViejo = nota({ title: 'Boca cerró el torneo con una victoria', topic: 'Fútbol', importanceScore: 60, publishedAt: hace(20) });
  const tenisNuevo = nota({ title: 'Boca Raton: final del torneo', topic: 'Tenis', importanceScore: 60, publishedAt: hace(1) });
  const expand = expansionFalsa(() => ({ q: 'boca', cat: 'Deportes', sub: 'Fútbol' }));
  const r = await correr(['boca'], { expand, busqueda: busquedaFalsa({ boca: [tenisNuevo, futbolViejo] }) });
  assert.equal(r.resultados[0].article.url, futbolViejo.url);
  assert.equal(r.resultados[0].ageHours, 20);
});

test('la pista llega a la búsqueda como consulta: queryExpanded es el "q" de la IA, y el resto del flujo no la usa de más', async () => {
  const a = nota({ title: 'Zverev avanzó en Shanghái', topic: 'Tenis' });
  const expand = expansionFalsa(() => ({ q: 'zverev atp alemania tenis', cat: 'Deportes', sub: 'Tenis' }));
  const r = await correr(['Zverev'], { expand, busqueda: busquedaFalsa({ Zverev: [a] }) });
  assert.equal(r.resultados[0].topic, 'Zverev');
  assert.equal(r.resultados[0].queryExpanded, 'zverev atp alemania tenis');
  assert.equal(r.busqueda.llamadas[0].vectorial, 'zverev atp alemania tenis');
});

// ================================================================ expansión que falla
test('si la expansión falla, devuelve basura o un texto, el tema se busca igual (tal cual o con ese texto) y el digest sigue', async () => {
  const a = nota({ title: 'River ganó en el Monumental' });
  const casos = [
    [() => { throw new Error('timeout de OpenAI'); }, 'river plate'],
    [() => null, 'river plate'],
    [() => undefined, 'river plate'],
    [() => '', 'river plate'],
    [() => ({ cat: 'Deportes' }), 'river plate'],
    [() => 'river plate monumental millonario', 'river plate monumental millonario'], // la forma vieja: un texto
  ];
  for (const [responder, esperada] of casos) {
    const r = await correr(['river plate'], { expand: expansionFalsa(responder), busqueda: busquedaFalsa({ 'river plate': [a] }) });
    assert.equal(r.resultados[0].article.url, a.url);
    assert.equal(r.resultados[0].queryExpanded, esperada);
    assert.equal(r.busqueda.llamadas[0].vectorial, esperada);
  }
});

test('un tópico oficial no se expande, no se busca y no se juzga', async () => {
  const oficial = nota({ publishedAt: hace(2), importanceScore: 80 });
  const juezTema = juezTemaFalso(() => 'SI');
  const r = await correr(['Fútbol'], { docs: [oficial], juezTema });
  assert.equal(r.resultados[0].article.url, oficial.url);
  assert.deepEqual(r.expand.llamadas, []);
  assert.equal(r.busqueda.llamadas.length, 0);
  assert.deepEqual(juezTema.registro.eventos, []);
});

// ================================================================ el juez de tema
function candidatosEnOrden() {
  const base = { category: 'Deportes', topic: 'Fútbol', score: 0.96 };
  return {
    a: nota({ ...base, title: 'River y Boca: la previa de la semana', importanceScore: 90, publishedAt: hace(1) }),
    b: nota({ ...base, title: 'River recibe a Racing el domingo', importanceScore: 80, publishedAt: hace(3) }),
    c: nota({ ...base, title: 'River ganó con un golazo de Colidio', importanceScore: 70, publishedAt: hace(5) }),
    d: nota({ ...base, title: 'River presentó su nueva camiseta', importanceScore: 60, publishedAt: hace(6) }),
  };
}

test('juez de tema: PARCIAL y NO descartan, se entrega la primera que dice SI, y el resultado lo deja escrito', async () => {
  const { a, b, c, d } = candidatosEnOrden();
  const juezTema = juezTemaFalso(porId({ [a._id]: 'PARCIAL', [b._id]: 'NO', [c._id]: 'SI', [d._id]: 'SI' }));
  const r = await correr(['river plate'], { busqueda: busquedaFalsa({ 'river plate': [d, c, b, a] }), juezTema });

  const x = r.resultados[0];
  assert.equal(x.article.url, c.url);
  assert.deepEqual(ids(juezTema.registro.preguntas), [a._id, b._id, c._id], 'pregunta en orden de calidad y para al primer SI (d no se pregunta)');
  assert.equal(x.candidatesEvaluated, 2, 'posición de la elegida en la lista de la búsqueda');
  assert.match(x.matchReason, /^VERDE score=0\.960 \(candidato #2\) \| tema: SI$/);
});

test('juez de tema: si NINGUNA dice SI, antes de irse a otro tema se acepta la mejor PARCIAL', async () => {
  const { a, b, c } = candidatosEnOrden();
  const rescate = nota({ category: 'Deportes', topic: 'Tenis', title: 'Balón de Oro', importanceScore: 90, publishedAt: hace(1) });
  const juezTema = juezTemaFalso(porId({}, 'PARCIAL'));
  const r = await correr(['river plate'], {
    busqueda: busquedaFalsa({ 'river plate': [a, b, c] }),
    docs: [rescate], // hay rescate disponible: igual se prefiere la PARCIAL del tema pedido
    juezTema,
  });

  const x = r.resultados[0];
  assert.equal(x.article.url, a.url, 'la mejor de las PARCIAL, no la nota de otro tema');
  assert.equal(x.usedFallback, false, 'no es un rescate: la nota nombra al tema que pidió el usuario');
  assert.match(x.matchReason, /\| tema: PARCIAL$/, 'queda escrito que se aceptó una parcial, para poder medirlo');
});

test('juez de tema: la PARCIAL se acepta también cuando no hay rescate posible (mejor de costado que nada)', async () => {
  const { a, b, c } = candidatosEnOrden();
  const juezTema = juezTemaFalso(porId({}, 'PARCIAL'));
  const r = await correr(['river plate'], { busqueda: busquedaFalsa({ 'river plate': [a, b, c] }), juezTema });
  assert.equal(r.resultados[0].article.url, a.url);

  // La segunda pasada vuelve a recorrer las mismas candidatas, pero no pregunta por ninguna nota NUEVA: en
  // producción esas repeticiones las contesta la caché de llmJudge (36 h), así que no se paga IA de nuevo.
  assert.deepEqual(
    [...new Set(ids(juezTema.registro.preguntas))],
    [a._id, b._id, c._id],
    'no se juzga ninguna nota que no se hubiera juzgado ya'
  );
});

test('juez de tema: el NO no pasa NUNCA, ni en la segunda pasada', async () => {
  const { a, b, c } = candidatosEnOrden();
  const juezTema = juezTemaFalso(porId({}, 'NO'));
  const r = await correr(['river plate'], { busqueda: busquedaFalsa({ 'river plate': [a, b, c] }), juezTema });
  assert.equal(r.resultados[0].matchReason, 'ningun_candidato_valido');
  assert.equal(r.resultados[0].article, null, 'mejor un hueco que una nota que no tiene nada que ver');
});

test('juez de tema: entre PARCIAL y NO, la segunda pasada toma la PARCIAL aunque esté más abajo', async () => {
  const { a, b, c } = candidatosEnOrden();
  const juezTema = juezTemaFalso(porId({ [a._id]: 'NO', [b._id]: 'NO', [c._id]: 'PARCIAL' }));
  const r = await correr(['river plate'], { busqueda: busquedaFalsa({ 'river plate': [a, b, c] }), juezTema });
  assert.equal(r.resultados[0].article.url, c.url);
  assert.match(r.resultados[0].matchReason, /\| tema: PARCIAL$/);
});

test('juez de tema: con un SI disponible no se usa ninguna PARCIAL', async () => {
  const { a, b, c } = candidatosEnOrden();
  const juezTema = juezTemaFalso(porId({ [a._id]: 'PARCIAL', [b._id]: 'PARCIAL', [c._id]: 'SI' }));
  const r = await correr(['river plate'], { busqueda: busquedaFalsa({ 'river plate': [a, b, c] }), juezTema });
  assert.equal(r.resultados[0].article.url, c.url);
  assert.match(r.resultados[0].matchReason, /\| tema: SI$/);
});

test('rescate: dos tópicos que fallan NO reciben el mismo hecho (el caso del Balón de Oro para boca y para river)', async () => {
  // Las dos notas del rescate cuentan el mismo evento con enfoques distintos: coseno 0,75, por debajo de la banda
  // normal del juez (0,80), que es por donde se escapaban.
  const balonA = nota({ topic: 'Tenis', title: 'Kane ganó el Balón de Oro 2026', importanceScore: 90, publishedAt: hace(1), embedding: conCoseno(1) });
  const balonB = nota({ topic: 'Tenis', title: 'España, campeona del mundo pero sin Balón de Oro', importanceScore: 85, publishedAt: hace(2), embedding: conCoseno(0.75) });
  const distinta = nota({ topic: 'Tenis', title: 'Del Potro al Salón de la Fama', importanceScore: 70, publishedAt: hace(3), embedding: [0, 1] });

  // El juez de misma historia dice que las dos del Balón de Oro son el mismo hecho.
  const titulosDelBalon = new Set([balonA.title, balonB.title]);
  const juez = {
    session: null,
    enabled: () => true,
    prefetch() {},
    async isSameEvent(cand, visto) {
      return { same: titulosDelBalon.has(cand.title) && titulosDelBalon.has(visto.title) };
    },
  };

  const r = await correr(['boca juniors', 'river plate'], {
    busqueda: busquedaFalsa({}),                 // ningún candidato propio: los dos van al rescate
    docs: [balonA, balonB, distinta],
    expand: expansionFalsa((t) => ({ q: t, cat: 'Deportes', sub: '' })),
    juezTema: juezTemaFalso(() => 'NO'),
    juez,
  });

  const [boca, river] = r.resultados;
  assert.equal(boca.usedFallback, true);
  assert.equal(river.usedFallback, true);
  assert.equal(boca.article.url, balonA.url, 'al primero le toca la más importante');
  assert.equal(
    river.article.url, distinta.url,
    'al segundo NO le toca la otra nota del mismo evento, aunque sea más importante que la distinta'
  );
});

test('juez de tema: si ninguna dice SI hay rescate en el rubro, y las notas del rescate NO pasan por el juez de tema', async () => {
  const { a, b, c } = candidatosEnOrden();
  const rescate = nota({ category: 'Deportes', topic: 'Tenis', title: 'Nota del rubro', importanceScore: 60, publishedAt: hace(4) });
  const juezTema = juezTemaFalso(porId({}, 'NO'));
  const r = await correr(['river plate'], {
    busqueda: busquedaFalsa({ 'river plate': [a, b, c] }),
    docs: [rescate], // el rescate lee el rubro por etiqueta, no con otra búsqueda
    juezTema,
  });
  assert.equal(r.busqueda.llamadas.length, 1, 'una sola búsqueda: la del tema');
  const x = r.resultados[0];
  assert.equal(x.article.url, rescate.url);
  assert.equal(x.usedFallback, true);
  assert.equal(x.matchZone, 'RESCATE');
  assert.equal(x.matchReason, 'ningun_candidato_valido');
  assert.equal(x.corralCategory, 'Deportes');
  assert.ok(!ids(juezTema.registro.preguntas).includes(rescate._id), 'el rescate no se juzga');
  assert.equal(juezTema.registro.preguntas.length, 3);
});

test('juez de tema: sin candidatos no se pregunta nada', async () => {
  const juezTema = juezTemaFalso(() => 'SI');
  const r = await correr(['river plate'], { busqueda: busquedaFalsa({ 'river plate': [] }), juezTema });
  assert.equal(r.resultados[0].article, null);
  assert.equal(r.resultados[0].matchReason, 'sin_candidatos');
  assert.deepEqual(juezTema.registro.eventos, []);
});

test('juez de tema: las que ya se vieron (misma historia por coseno) no gastan preguntas', async () => {
  const { a, b, c } = candidatosEnOrden();
  const repetida = { ...a, embedding: conCoseno(0.95) };
  const juezTema = juezTemaFalso(() => 'SI');
  const r = await correr(['river plate'], {
    docs: [repetida, b, c], busqueda: busquedaFalsa({ 'river plate': [repetida, b, c] }), juezTema,
    vistos: [{ id: 'visto', title: 'Ya la vio', vector: [1, 0] }],
  });
  assert.equal(r.resultados[0].article.url, b.url);
  assert.ok(!ids(juezTema.registro.preguntas).includes(a._id), 'la repetida se descarta antes de preguntarle al juez');
  assert.deepEqual(ids(juezTema.registro.preguntas), [b._id]);
});

test('juez de tema: al juez le llega el tema que escribió el usuario y la nota con id, título y bajada', async () => {
  const a = nota({ title: 'River ganó en el Monumental', rawSummary: 'El Millonario se impuso 2 a 0 con goles de Colidio.' });
  const juezTema = juezTemaFalso(() => 'SI');
  await correr(['  river plate  '], { busqueda: busquedaFalsa({ 'river plate': [a] }), juezTema });
  assert.deepEqual(juezTema.registro.preguntas[0], {
    tema: 'river plate', id: a._id, title: a.title, lead: a.rawSummary,
  });
});

// ================================================================ corral blando
/** "inflación": una nota de Política (la más nueva e importante) entre cuatro de Economía (el corral). */
function inflacionConUnaDePolitica() {
  const base = { category: 'Economía', topic: 'Inflación y Consumo', score: 0.9 };
  const politica = nota({ category: 'Política', topic: 'Gobierno Nacional', title: 'El Gobierno celebra la baja de la inflación', score: 0.97, importanceScore: 85, publishedAt: hace(1) });
  const eco1 = nota({ ...base, title: 'La inflación de septiembre fue del 2,1%', importanceScore: 70, publishedAt: hace(5) });
  const eco2 = nota({ ...base, title: 'Qué pasó con la inflación en alimentos', score: 0.88, importanceScore: 65, publishedAt: hace(7) });
  const eco3 = nota({ ...base, title: 'Inflación: las consultoras proyectan octubre', score: 0.86, importanceScore: 60, publishedAt: hace(8) });
  return { politica, eco1, eco2, eco3, busqueda: () => busquedaFalsa({ inflación: [politica, eco1, eco2, eco3] }) };
}

test('corral blando: una nota de otra categoría que el juez confirma (SI) se entrega aunque no sea del corral', async () => {
  const { politica, busqueda } = inflacionConUnaDePolitica();
  const juezTema = juezTemaFalso(() => 'SI');
  const r = await correr(['inflación'], { busqueda: busqueda(), juezTema });
  const x = r.resultados[0];
  assert.equal(x.article.url, politica.url);
  assert.equal(x.corralCategory, 'Economía', 'el corral se infiere igual');
  assert.equal(x.matchZone, 'VERDE');
  assert.match(x.matchReason, / \| tema: SI$/);
  assert.equal(juezTema.registro.prefetch[0].id, politica._id, 'también se adelanta la pregunta de la nota de afuera: es la mejor');
});

test('corral blando: si el juez dice que la de afuera no es del tema (PARCIAL o NO), se entrega la mejor de adentro', async () => {
  const { politica, eco1, busqueda } = inflacionConUnaDePolitica();
  for (const veredicto of ['PARCIAL', 'NO']) {
    const juezTema = juezTemaFalso(porId({ [politica._id]: veredicto }));
    const r = await correr(['inflación'], { busqueda: busqueda(), juezTema });
    assert.equal(r.resultados[0].article.url, eco1.url, veredicto);
    assert.deepEqual(ids(juezTema.registro.preguntas), [politica._id, eco1._id]);
  }
});

test('sin juez de tema el corral descarta como siempre: la nota de afuera no se entrega ni se pregunta nada', async () => {
  const { eco1, busqueda } = inflacionConUnaDePolitica();
  const r = await correr(['inflación'], { busqueda: busqueda(), juezTema: null });
  assert.equal(r.resultados[0].article.url, eco1.url);
  assert.doesNotMatch(r.resultados[0].matchReason, /tema:/);
});

test('con el juez apagado (TOPIC_JUDGE=off) pasa lo mismo que sin juez, y no se le consulta ni se le adelanta nada', async () => {
  const { eco1, busqueda } = inflacionConUnaDePolitica();
  const juezTema = juezTemaFalso(() => 'SI', { activo: false });
  const r = await correr(['inflación'], { busqueda: busqueda(), juezTema });
  assert.equal(r.resultados[0].article.url, eco1.url);
  assert.deepEqual(juezTema.registro.eventos, []);
  assert.doesNotMatch(r.resultados[0].matchReason, /tema:/);
});

test('sin veredicto (tardó, falló o no se entendió): pasa la candidata de adentro del corral y la de afuera no', async () => {
  const { politica, eco1, busqueda } = inflacionConUnaDePolitica();
  const juezTema = juezTemaFalso(() => null);
  const r = await correr(['inflación'], { busqueda: busqueda(), juezTema });
  assert.equal(r.resultados[0].article.url, eco1.url, 'la de Política, la mejor, queda afuera: nadie la confirmó');
  assert.match(r.resultados[0].matchReason, / \| tema: sin veredicto$/);
  assert.deepEqual(ids(juezTema.registro.preguntas), [politica._id, eco1._id]);
});

test('un juez que lanza un error no frena la elección: es lo mismo que "sin veredicto"', async () => {
  const { eco1, busqueda } = inflacionConUnaDePolitica();
  const juezTema = juezTemaFalso(() => new Error('se cayó el juez'));
  const r = await correr(['inflación'], { busqueda: busqueda(), juezTema });
  assert.equal(r.resultados[0].article.url, eco1.url);
  assert.match(r.resultados[0].matchReason, / \| tema: sin veredicto$/);
});

test('con juez y sin corral inferido (pocos candidatos) cada nota pasa por el juez, y sin veredicto no hay nada "afuera" que descartar', async () => {
  const { a, b } = candidatosEnOrden();
  const busqueda = () => busquedaFalsa({ 'river plate': [a, b] });

  const conVeredicto = juezTemaFalso(porId({ [a._id]: 'NO' }));
  const r1 = await correr(['river plate'], { busqueda: busqueda(), juezTema: conVeredicto });
  assert.equal(r1.resultados[0].corralCategory, null, 'dos candidatos no alcanzan para inferir un corral');
  assert.equal(r1.resultados[0].article.url, b.url);
  assert.deepEqual(ids(conVeredicto.registro.preguntas), [a._id, b._id]);

  const sinVeredicto = await correr(['river plate'], { busqueda: busqueda(), juezTema: juezTemaFalso(() => null) });
  assert.equal(sinVeredicto.resultados[0].article.url, a.url, 'sin corral nadie está afuera: sin veredicto pasa la mejor');
  assert.match(sinVeredicto.resultados[0].matchReason, / \| tema: sin veredicto$/);
});

// ================================================================ las dos fases
test('fase 1: la expansión de todos los tópicos libres sale junta (no se esperan entre sí)', async () => {
  let abrir;
  const puerta = new Promise((ok) => { abrir = ok; });
  const expand = expansionFalsa(async (t) => {
    if (expand.llamadas.length === 3) abrir(); // recién cuando salieron las tres, ninguna se queda esperando a las otras
    await puerta;
    return { q: `${t} expandido`, cat: '', sub: '' };
  });
  const notas = { 'river plate': nota({ title: 'River ganó' }), boca: nota({ title: 'Boca empató' }), racing: nota({ title: 'Racing perdió' }) };
  const r = await antesDe(2000, 'los tópicos libres se esperaron entre sí (las expansiones salieron en fila)', correr(['river plate', 'boca', 'racing'], {
    expand, busqueda: busquedaFalsa(Object.fromEntries(Object.entries(notas).map(([t, n]) => [t, [n]]))),
  }));
  assert.deepEqual(expand.llamadas, ['river plate', 'boca', 'racing']);
  assert.deepEqual(urls(r), [notas['river plate'].url, notas.boca.url, notas.racing.url]);
});

test('fase 1: las búsquedas de todos los tópicos libres salen juntas, antes de elegir la primera', async () => {
  let abrir;
  const puerta = new Promise((ok) => { abrir = ok; });
  const notas = { 'river plate': nota({ title: 'River ganó' }), boca: nota({ title: 'Boca empató' }) };
  const busqueda = busquedaFalsa(async (exacta) => {
    if (busqueda.llamadas.length === 2) abrir();
    await puerta;
    return [notas[exacta]];
  });
  const r = await antesDe(2000, 'las búsquedas de los tópicos libres salieron en fila', correr(['river plate', 'boca'], { busqueda }));
  assert.deepEqual(busqueda.llamadas.map((l) => l.exacta), ['river plate', 'boca']);
  assert.deepEqual(urls(r), [notas['river plate'].url, notas.boca.url]);
});

test('fase 1: las preguntas al juez de las 3 primeras candidatas salen por adelantado, antes de la primera pregunta de la elección', async () => {
  const { a, b, c, d } = candidatosEnOrden();
  const juezTema = juezTemaFalso(() => 'SI');
  await correr(['river plate'], { busqueda: busquedaFalsa({ 'river plate': [d, c, b, a] }), juezTema });

  const { eventos } = juezTema.registro;
  const primeraPregunta = eventos.findIndex((e) => e[0] === 'pregunta');
  const adelantadas = eventos.slice(0, primeraPregunta);
  assert.ok(primeraPregunta >= 3, 'primero salen los adelantos');
  assert.deepEqual(adelantadas.slice(0, 3).map((e) => [e[0], e[2]]), [['prefetch', a._id], ['prefetch', b._id], ['prefetch', c._id]], 'las 3 mejores, en orden de calidad');
  assert.ok(eventos.every((e) => e[2] !== d._id), 'la cuarta nunca se adelanta ni se pregunta');
});

test('fase 1 con copia de las exclusiones del arranque: el 2.º tópico adelanta la nota que el 1.º se va a llevar, pero la elección no se la entrega', async () => {
  const { a, b, c, d } = candidatosEnOrden();
  const lista = [a, b, c, d];
  const juezTema = juezTemaFalso(() => 'SI');
  const r = await correr(['river plate', 'river'], {
    docs: lista, busqueda: busquedaFalsa({ 'river plate': lista, river: lista }), juezTema,
  });
  assert.deepEqual(urls(r), [a.url, b.url], 'la elección es la de siempre: cada tópico, con lo ya elegido para los anteriores');
  const adelantosDelSegundo = juezTema.registro.prefetch.filter((p) => p.tema === 'river').map((p) => p.id);
  assert.ok(adelantosDelSegundo.includes(a._id), 'el adelanto usa las exclusiones del arranque (sin lo que elige el 1.º)');
  const preguntasDelSegundo = juezTema.registro.preguntas.filter((p) => p.tema === 'river').map((p) => p.id);
  assert.ok(!preguntasDelSegundo.includes(a._id), 'pero a la nota ya elegida no se le pregunta: la frena la URL');
});

test('fase 1: aunque la búsqueda del 2.º tópico termine cuando el 1.º ya eligió, sus adelantos usan las exclusiones del arranque', async () => {
  const { a, b, c, d } = candidatosEnOrden();
  const lista = [a, b, c, d];
  const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const busqueda = busquedaFalsa(async (exacta) => { if (exacta === 'river') await pausa(40); return lista; });
  const juezTema = juezTemaFalso(() => 'SI');
  const r = await correr(['river plate', 'river'], { docs: lista, busqueda, juezTema });
  assert.deepEqual(urls(r), [a.url, b.url]);
  const adelantos = juezTema.registro.prefetch.filter((p) => p.tema === 'river').map((p) => p.id);
  assert.deepEqual(adelantos.slice(0, 3), [a._id, b._id, c._id], 'los primeros 3 adelantos son de la fase 1: la lista como estaba al arrancar');
});

test('el orden en que terminan las búsquedas no cambia la elección (se elige siempre en el orden de los tópicos)', async () => {
  const { a, b, c } = candidatosEnOrden();
  const lista = [a, b, c];
  const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const lenta = busquedaFalsa(async (exacta) => { if (exacta === 'river plate') await pausa(40); return lista; });
  const rapida = busquedaFalsa(async () => lista);
  const conDemora = await correr(['river plate', 'boca'], { busqueda: lenta, docs: lista });
  const sinDemora = await correr(['river plate', 'boca'], { busqueda: rapida, docs: lista });
  assert.deepEqual(urls(conDemora), [a.url, b.url], 'el 1.º tópico se lleva la mejor aunque su búsqueda terminó última');
  assert.deepEqual(urls(sinDemora), urls(conDemora));
});

test('un tópico libre repetido se expande y se busca UNA vez, pero el digest lleva dos notas distintas', async () => {
  const { a, b, c } = candidatosEnOrden();
  const r = await correr(['river plate', 'river plate'], { busqueda: busquedaFalsa({ 'river plate': [a, b, c] }), docs: [a, b, c] });
  assert.deepEqual(r.expand.llamadas, ['river plate']);
  assert.equal(r.busqueda.llamadas.length, 1);
  assert.deepEqual(urls(r), [a.url, b.url]);
  assert.equal(r.resultados[1].queryExpanded, 'river plate expandido');
});

test('si la búsqueda de un tópico falla, ese queda en error_busqueda (con su rescate) y los demás siguen', async () => {
  const boca = nota({ title: 'Boca empató' });
  const rescate = nota({ category: 'Sociedad', topic: 'Salud', importanceScore: 60 });
  const busqueda = busquedaFalsa({ 'river plate': new Error('Atlas caído'), boca: [boca] });
  const r = await correr(['river plate', 'boca'], { busqueda, docs: [rescate], juezTema: juezTemaFalso(() => 'SI') });
  assert.equal(r.resultados[0].matchReason, 'error_busqueda');
  assert.equal(r.resultados[0].article.url, rescate.url);
  assert.equal(r.resultados[0].usedFallback, true);
  assert.equal(r.resultados[1].article.url, boca.url);
});

test('mezcla: un tópico oficial y uno libre con juez no se repiten nota, y el juez solo ve lo del libre', async () => {
  const oficial = nota({ title: 'Gran triunfo del seleccionado', publishedAt: hace(2), importanceScore: 80 });
  const libre = nota({ title: 'River ganó en el Monumental', importanceScore: 70, publishedAt: hace(4) });
  const juezTema = juezTemaFalso(() => 'SI');
  const r = await correr(['Fútbol', 'river plate'], {
    docs: [oficial], busqueda: busquedaFalsa({ 'river plate': [oficial, libre] }), juezTema,
  });
  assert.equal(r.resultados[0].article.url, oficial.url);
  assert.equal(r.resultados[1].article.url, libre.url, 'la nota que ya salió para "Fútbol" se saltea');
  assert.ok(juezTema.registro.eventos.every((e) => e[1] === 'river plate'));
});

// ================================================================ presupuesto de espera: uno por digest
test('los dos jueces comparten el MISMO presupuesto de espera del digest (judgeWaitMs), y sin el dato se usa el de fábrica', async () => {
  const sesiones = [];
  const deps = {
    search: busquedaFalsa({}), expand: expansionFalsa(), store: storeFalso([]),
    createJudge: ({ session }) => { sesiones.push(['misma historia', session]); return null; },
    createTopicJudge: ({ session }) => { sesiones.push(['tema', session]); return null; },
  };
  await pickBestArticlePerTopic(['river plate'], { now: NOW, judgeWaitMs: 777, deps });
  assert.deepEqual(sesiones.map((s) => s[0]), ['misma historia', 'tema']);
  assert.equal(sesiones[0][1], sesiones[1][1], 'una sola sesión: lo que espera uno se le descuenta al otro');
  assert.equal(sesiones[0][1].budgetMs, 777);

  for (const [dato, esperado] of [[0, 0], [undefined, judgeWaitBudgetMs()], [null, judgeWaitBudgetMs()], [-5, judgeWaitBudgetMs()], [NaN, judgeWaitBudgetMs()]]) {
    sesiones.length = 0;
    await pickBestArticlePerTopic(['river plate'], { now: NOW, judgeWaitMs: dato, deps });
    assert.equal(sesiones[0][1].budgetMs, esperado, `judgeWaitMs ${dato}`);
  }
});

// ================================================================ con el juez real (IA falsa)
const respuesta = (texto) => ({ choices: [{ message: { content: texto } }] });

function clienteFalso(responder) {
  const llamadas = [];
  return {
    llamadas,
    chat: { completions: { create: async (body, opts) => { llamadas.push({ body, opts }); return responder(body, opts); } } },
  };
}

test('con el juez real: la IA recibe el tema y la nota, PARCIAL descarta, y el motor deja la línea [Juez] del digest', async () => {
  const { a, b, c } = candidatosEnOrden();
  const cliente = clienteFalso((body) => respuesta(body.messages[1].content.includes(`TÍTULO: ${a.title}`) ? 'PARCIAL' : 'SI'));
  const logs = [];
  const anterior = console.log;
  console.log = (...partes) => logs.push(partes.join(' '));
  let resultados;
  try {
    resultados = await pickBestArticlePerTopic(['river plate'], {
      now: NOW,
      deps: {
        search: busquedaFalsa({ 'river plate': [a, b, c] }), expand: expansionFalsa(), store: storeFalso([]), judge: null,
        createTopicJudge: ({ session }) => createTopicJudge({ session, llm: createTopicLlm({ getClient: () => cliente, env: {}, log: () => {} }) }),
      },
    });
  } finally {
    console.log = anterior;
  }

  assert.equal(resultados[0].article.url, b.url, 'la primera era PARCIAL: se entrega la siguiente');
  assert.match(resultados[0].matchReason, / \| tema: SI$/);
  assert.equal(cliente.llamadas.length, 3, 'las 3 candidatas se preguntaron juntas, por adelantado');
  const pregunta = cliente.llamadas.find((l) => l.body.messages[1].content.includes(b.title)).body.messages[1].content;
  assert.equal(pregunta, `TEMA: river plate\nTÍTULO: ${b.title}\nRESUMEN: ${b.rawSummary}`);
  assert.ok(logs.some((l) => /^\[Juez\] \d+ llamadas, \d+ de caché, \d+ ms de espera/.test(l)), logs.join('\n'));
});

test('con el juez real apagado (TOPIC_JUDGE=off) no hay ninguna llamada y el corral descarta como siempre', async () => {
  const { politica, eco1, busqueda } = inflacionConUnaDePolitica();
  const cliente = clienteFalso(() => { throw new Error('no debería llamarse'); });
  const resultados = await pickBestArticlePerTopic(['inflación'], {
    now: NOW,
    deps: {
      search: busqueda(), expand: expansionFalsa(), store: storeFalso([]), judge: null,
      createTopicJudge: ({ session }) => createTopicJudge({ session, llm: createTopicLlm({ getClient: () => cliente, env: { TOPIC_JUDGE: 'off' }, log: () => {} }) }),
    },
  });
  assert.equal(cliente.llamadas.length, 0);
  assert.equal(resultados[0].article.url, eco1.url);
  assert.notEqual(resultados[0].article.url, politica.url);
});

test('extremo a extremo: expansión con IA falsa (pista incluida) + juez real con IA falsa', async () => {
  const futbol = nota({ title: 'Boca ganó en la Bombonera', topic: 'Fútbol', importanceScore: 60, publishedAt: hace(8) });
  const tenis = nota({ title: 'Boca Raton: final del torneo de tenis', topic: 'Tenis', importanceScore: 90, publishedAt: hace(1) });
  const clienteExpansion = clienteFalso(() => respuesta(JSON.stringify({ q: 'Boca Juniors, Bombonera xeneize', cat: 'deportes', sub: 'futbol' })));
  const clienteJuez = clienteFalso((body) => respuesta(/Raton/.test(body.messages[1].content) ? 'NO' : 'SI'));
  const expansor = createTopicExpander({ getClient: () => clienteExpansion, log: () => {}, warn: () => {} });

  const resultados = await pickBestArticlePerTopic(['boca'], {
    now: NOW,
    deps: {
      search: busquedaFalsa({ boca: [tenis, futbol] }), expand: expansor.expand, store: storeFalso([]), judge: null,
      createTopicJudge: ({ session }) => createTopicJudge({ session, llm: createTopicLlm({ getClient: () => clienteJuez, env: {}, log: () => {} }) }),
    },
  });
  assert.equal(resultados[0].queryExpanded, 'boca juniors bombonera xeneize');
  assert.equal(resultados[0].article.url, futbol.url);
  assert.match(resultados[0].matchReason, / \| tema: SI$/);
  assert.equal(clienteExpansion.llamadas.length, 1);
});

// ================================================================ firstNotRepeated con el filtro de tema
const entrada = (doc) => ({ article: doc, tier: 'buena', ageHours: 3, importance: doc.importanceScore });

/** loadDocs falso (solo el embedding, como en los temas libres); anota los lotes que se piden. */
function cargador(docs, lotes = []) {
  return async (idsPedidos) => {
    lotes.push(idsPedidos.map(String));
    const quiero = new Set(idsPedidos.map(String));
    return new Map(docs.filter((d) => quiero.has(String(d._id))).map((d) => [String(d._id), { embedding: d.embedding }]));
  };
}

/** Filtro de tema falso, con la forma de createTopicCheck. `decide(entrada, doc)` -> { ok, verdict, reason }. */
function filtroTemaFalso(decide = () => ({ ok: true, verdict: 'SI', reason: null })) {
  const registro = { prefetch: [], check: [] };
  return {
    registro,
    prefetch(entry) { registro.prefetch.push(entry.article._id); },
    async check(entry, doc) { registro.check.push(entry.article._id); return decide(entry, doc); },
  };
}

const rechaza = (verdict) => ({ ok: false, verdict, reason: `tema_${verdict.toLowerCase()}` });
const vista = (extra = {}) => ({ id: 'visto', title: 'Ya la vio', lead: '', vector: [1, 0], ...extra });

test('firstNotRepeated + filtro de tema: devuelve la primera que el filtro acepta con su veredicto, y deja las descartadas anotadas', async () => {
  const [a, b, c] = ['a', 'b', 'c'].map((t) => nota({ title: `Nota ${t}` }));
  const filtro = filtroTemaFalso((e) => ({ [a._id]: rechaza('PARCIAL'), [b._id]: rechaza('NO'), [c._id]: { ok: true, verdict: 'SI', reason: null } })[e.article._id]);
  const r = await firstNotRepeated([a, b, c].map(entrada), { seenEmbeddings: [], loadDocs: cargador([a, b, c]), needsDoc: false, topicCheck: filtro });

  assert.equal(r.hit.entry.article._id, c._id);
  assert.equal(r.hit.topicVerdict, 'SI');
  assert.deepEqual(r.offTopic, [
    { title: a.title, verdict: 'PARCIAL', reason: 'tema_parcial' },
    { title: b.title, verdict: 'NO', reason: 'tema_no' },
  ]);
  assert.equal(r.examined, 3);
  assert.deepEqual(r.skipped, []);
});

test('firstNotRepeated + filtro de tema: sin filtro todo sigue igual (topicVerdict null, offTopic vacío)', async () => {
  const a = nota();
  const r = await firstNotRepeated([entrada(a)], { seenEmbeddings: [], loadDocs: cargador([a]), needsDoc: false });
  assert.equal(r.hit.entry.article._id, a._id);
  assert.equal(r.hit.topicVerdict, null);
  assert.deepEqual(r.offTopic, []);
});

test('firstNotRepeated + filtro de tema: aunque no haya historial se traen varios finalistas por vez (sin filtro, uno solo)', async () => {
  const docs = Array.from({ length: 5 }, () => nota());
  const conFiltro = [];
  await firstNotRepeated(docs.map(entrada), { seenEmbeddings: [], loadDocs: cargador(docs, conFiltro), needsDoc: false, topicCheck: filtroTemaFalso() });
  assert.deepEqual(conFiltro.map((l) => l.length), [5]);

  const sinFiltro = [];
  await firstNotRepeated(docs.map(entrada), { seenEmbeddings: [], loadDocs: cargador(docs, sinFiltro), needsDoc: false });
  assert.deepEqual(sinFiltro.map((l) => l.length), [1]);
});

test('firstNotRepeated + filtro de tema: adelanta las preguntas de las 3 primeras que NO son repetidas por coseno, y a las repetidas no les pregunta', async () => {
  const repetida = nota({ embedding: conCoseno(0.95) });
  const [b, c, d, e] = [0, 1, 2, 3].map(() => nota());
  const filtro = filtroTemaFalso();
  const r = await firstNotRepeated([repetida, b, c, d, e].map(entrada), {
    seenEmbeddings: [vista()], loadDocs: cargador([repetida, b, c, d, e]), needsDoc: false, topicCheck: filtro,
  });
  assert.deepEqual(filtro.registro.prefetch, [b._id, c._id, d._id], 'la repetida no gasta adelanto y el tope son 3');
  assert.deepEqual(filtro.registro.check, [b._id], 'se revisa una por una, y a la repetida no se le consulta el tema');
  assert.equal(r.hit.entry.article._id, b._id);
  assert.deepEqual(r.skipped.map((s) => [s.title, s.by]), [[repetida.title, 'coseno']]);
});

test('firstNotRepeated + filtro de tema: una candidata sin embedding también pasa por el filtro (no se puede comparar la historia)', async () => {
  const sinVector = nota({ embedding: [] });
  const filtro = filtroTemaFalso();
  const r = await firstNotRepeated([entrada(sinVector)], { seenEmbeddings: [vista()], loadDocs: cargador([sinVector]), needsDoc: false, topicCheck: filtro });
  assert.equal(r.hit.entry.article._id, sinVector._id);
  assert.equal(r.hit.embedding, null);
  assert.deepEqual(filtro.registro.check, [sinVector._id]);
});

test('firstNotRepeated + filtro de tema: si el filtro rechaza todo no hay nota, y se rinde a los 32 finalistas (4 lotes de 8)', async () => {
  const tres = [0, 1, 2].map(() => nota());
  const r = await firstNotRepeated(tres.map(entrada), { seenEmbeddings: [], loadDocs: cargador(tres), needsDoc: false, topicCheck: filtroTemaFalso(() => rechaza('NO')) });
  assert.equal(r.hit, null);
  assert.equal(r.offTopic.length, 3);

  const cuarenta = Array.from({ length: 40 }, () => nota());
  const lotes = [];
  const filtro = filtroTemaFalso(() => rechaza('NO'));
  const tope = await firstNotRepeated(cuarenta.map(entrada), { seenEmbeddings: [], loadDocs: cargador(cuarenta, lotes), needsDoc: false, topicCheck: filtro });
  assert.equal(tope.hit, null);
  assert.deepEqual(lotes.map((l) => l.length), [8, 8, 8, 8]);
  assert.equal(filtro.registro.check.length, 32, 'la 33.ª ni se mira');
});

// ================================================================ tope de tópicos libres en paralelo
test('fase 1: como mucho 6 tópicos libres hacen su trabajo de red a la vez (los demás esperan su turno) y el resultado no cambia', async () => {
  const temas = Array.from({ length: 14 }, (_, i) => `tema numero ${i + 1}`);
  const notas = Object.fromEntries(temas.map((t) => [t, nota({ title: `Noticia de ${t}` })]));
  const pausa = () => new Promise((ok) => setTimeout(ok, 8));

  let enCurso = 0;
  let maximo = 0;
  const entrar = () => { enCurso++; maximo = Math.max(maximo, enCurso); };
  const salir = () => { enCurso--; };

  const expand = expansionFalsa(async (t) => { entrar(); await pausa(); salir(); return { q: `${t} expandido`, cat: '', sub: '' }; });
  const busqueda = busquedaFalsa(async (exacta) => { entrar(); await pausa(); salir(); return [notas[exacta]]; });

  const r = await correr(temas, { expand, busqueda });
  assert.equal(maximo, 6, 'llegan a 6 a la vez, no a 14');
  assert.deepEqual(urls(r), temas.map((t) => notas[t].url), 'cada tópico, su nota, en el orden de siempre');
  assert.equal(expand.llamadas.length, 14);
  assert.equal(busqueda.llamadas.length, 14);
});

test('fase 1: un tópico cuya búsqueda falla devuelve su lugar al tope (no traba a los que esperan)', async () => {
  const temas = Array.from({ length: 9 }, (_, i) => `tema ${i + 1}`);
  const notas = Object.fromEntries(temas.map((t) => [t, nota({ title: `Noticia de ${t}` })]));
  const busqueda = busquedaFalsa((exacta) => (['tema 1', 'tema 2', 'tema 3'].includes(exacta) ? new Error('Atlas caído') : [notas[exacta]]));
  const r = await antesDe(3000, 'los tópicos que esperaban su turno quedaron colgados', correr(temas, { busqueda }));
  assert.deepEqual(r.resultados.map((x) => x.matchReason).slice(0, 3), ['error_busqueda', 'error_busqueda', 'error_busqueda']);
  assert.deepEqual(urls(r).slice(3), temas.slice(3).map((t) => notas[t].url));
});

// ---------------------------------------------------------------- concurrencyGate (el tope en sí)
/** Una tarea que queda "corriendo" hasta que el test la termina; anota cuántas hay corriendo a la vez. */
function tareasManuales() {
  const estado = { corriendo: 0, maximo: 0, orden: [] };
  const nueva = (nombre, { falla = false } = {}) => {
    let terminar;
    const tarea = async () => {
      estado.corriendo++;
      estado.maximo = Math.max(estado.maximo, estado.corriendo);
      estado.orden.push(nombre);
      await new Promise((ok) => { terminar = ok; });
      estado.corriendo--;
      if (falla) throw new Error(`falló ${nombre}`);
      return nombre;
    };
    tarea.terminar = () => terminar();
    return tarea;
  };
  return { estado, nueva };
}
const turno = () => new Promise((ok) => setImmediate(ok));

test('concurrencyGate: corre enseguida hasta `max` tareas, las demás esperan su turno y arrancan en el orden en que llegaron', async () => {
  const run = createGate(2);
  const { estado, nueva } = tareasManuales();
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((n) => nueva(n));
  const resultados = [run(a), run(b), run(c), run(d)];
  await turno();
  assert.deepEqual(estado.orden, ['a', 'b'], 'solo dos arrancaron');

  a.terminar();
  await turno();
  assert.deepEqual(estado.orden, ['a', 'b', 'c']);
  b.terminar();
  await turno();
  assert.deepEqual(estado.orden, ['a', 'b', 'c', 'd']);
  c.terminar();
  d.terminar();
  assert.deepEqual(await Promise.all(resultados), ['a', 'b', 'c', 'd']);
  assert.equal(estado.maximo, 2);
});

test('concurrencyGate: una tarea que llega justo cuando otra termina no se cuela por delante del tope', async () => {
  const run = createGate(2);
  const { estado, nueva } = tareasManuales();
  const [a, b, c, e] = ['a', 'b', 'c', 'e'].map((n) => nueva(n));
  const resultados = [run(a), run(b), run(c)]; // c espera
  await turno();
  a.terminar();
  await turno(); // c tomó el lugar de a
  const llegaDespues = run(e); // b y c están corriendo: e tiene que esperar
  await turno();
  assert.deepEqual(estado.orden, ['a', 'b', 'c'], 'e no arrancó');
  assert.equal(estado.corriendo, 2);

  b.terminar();
  await turno();
  assert.deepEqual(estado.orden, ['a', 'b', 'c', 'e']);
  c.terminar();
  e.terminar();
  await Promise.all([...resultados, llegaDespues]);
  assert.equal(estado.maximo, 2, 'nunca hubo más de dos a la vez');
});

test('concurrencyGate: una tarea que falla devuelve su lugar y el error le llega a quien la pidió', async () => {
  const run = createGate(1);
  const { estado, nueva } = tareasManuales();
  const mala = nueva('mala', { falla: true });
  const buena = nueva('buena');
  const pedidaMala = run(mala);
  const pedidaBuena = run(buena);
  pedidaMala.catch(() => {});
  await turno();
  assert.deepEqual(estado.orden, ['mala']);
  mala.terminar();
  await assert.rejects(pedidaMala, /falló mala/);
  await turno();
  assert.deepEqual(estado.orden, ['mala', 'buena'], 'la que esperaba arrancó igual');
  buena.terminar();
  assert.equal(await pedidaBuena, 'buena');
});

test('concurrencyGate: un tope inválido (0, negativo, NaN) se toma como 1', async () => {
  for (const max of [0, -3, NaN, undefined, 'x']) {
    const run = createGate(max);
    const { estado, nueva } = tareasManuales();
    const [a, b] = [nueva('a'), nueva('b')];
    const pedidas = [run(a), run(b)];
    await turno();
    assert.deepEqual(estado.orden, ['a'], `max=${String(max)}`);
    a.terminar();
    await turno();
    b.terminar();
    await Promise.all(pedidas);
  }
});
