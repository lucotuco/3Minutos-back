'use strict';

/**
 * El caso real de "Tenis Argentino" del 14/11/2026 (digest de las 9, armado a las 8:45):
 *
 *   - Perfil y Olé (13/11, 13 h ARG): "Tirante se metió en la final"; el rival todavía no se sabía.
 *   - La Nación (13/11, 19:49 ARG): lo mismo, pero ya con el rival (Fritz) y la hora (las 9). Era la mejor versión y
 *     quedaba afuera por el ancla léxica: su texto dice "ATP" y "tenista", nunca "tenis", y la IA no le puso la
 *     etiqueta "tenis" (a las otras dos sí). La IA sí la había clasificado con el subtema Tenis.
 *   - Olé (13/11, 17:55 ARG): "Tirante vs. Fritz: a qué hora juegan y dónde ver la final", una previa: sigue afuera.
 *
 * Los textos son los reales (recortados). Mongo, búsqueda, expansión e IA son FALSOS: ningún test llama a OpenAI.
 * Correr:  npm run test:unit
 */

process.env.OPENAI_API_KEY_EMBEDDINGS ||= 'test';
process.env.OPENAI_API_KEY_REVIEW ||= 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { pickBestArticlePerTopic } = require('../../utils/pickBestArticlePerTopic');
const { matchesAnchors, selectBestCandidate } = require('../../utils/topicMatching');
const { checkEligibility } = require('../../utils/eligibility');

test.before(() => {
  for (const m of ['log', 'warn', 'error']) console[m] = () => {};
});

// 14/11/2026 11:45 UTC = sábado 8:45 en Argentina (cuando se armó el digest de las 9).
const NOW = Date.parse('2026-11-14T11:45:00.000Z');

let seq = 0;
const unico = (i) => Array.from({ length: 64 }, (_, k) => (k === i % 64 ? 1 : 0));

function nota(extra) {
  const i = seq++;
  return {
    _id: `t${String(i).padStart(4, '0')}`,
    category: 'Deportes',
    topic: 'Tenis',
    geoScope: 'Argentina',
    section: '',
    rawSummary: '',
    contentType: 'noticia',
    embedding: unico(i),
    ...extra,
  };
}

const perfil = () => nota({
  url: 'https://perfil.com/deportes/thiago-tirante-se-metio-en-la-final-del-ultimo-torneo-atp-del-ano',
  title: 'Thiago Tirante se metió en la final del último torneo ATP del año',
  contentSnippet: 'Habrá un tenista argentino en la última final ATP de la temporada regular 2026. El platense Thiago Tirante '
    + 'estiró su buen andar en Estocolmo y se clasificó para la cita decisiva tras imponerse 7-5 y 7-6(1) sobre el '
    + 'chileno Alejandro Talibo. Su rival saldrá del vencedor del partido entre Taylor Fritz y Lorenzo Musetti, con la '
    + 'definición disputándose desde las 9.00hs (Argentina) del sábado 14 de noviembre.',
  tags: ['thiago tirante', 'atp', 'tenis'],
  importanceScore: 70,
  publishedAt: new Date('2026-11-13T16:28:51.000Z'),
  sourceName: 'Perfil Home',
  score: 0.969,
});

const oleNoticia = () => nota({
  url: 'https://www.ole.com.ar/tenis/thiago-tirante-final-atp-estocolmo-titulo',
  title: 'Tirante pasó a la final del ATP de Estocolmo y va por su primer título',
  contentSnippet: 'En el ATP 250 de Estocolmo el platense avanzó a la final e irá por su primer título ATP. Su víctima '
    + 'en la semifinal fue el chileno Alejandro Tabilo. "Estoy feliz de estar en mi primera final ATP", dijo el '
    + 'tenista argentino. El rival de Thiago aún no está confirmado. La final se jugará el sábado a las 9.',
  tags: ['thiago tirante', 'atp estocolmo', 'final', 'tenis', 'deporte'],
  importanceScore: 70,
  publishedAt: new Date('2026-11-13T16:07:29.000Z'),
  sourceName: 'Ole Lo Ultimo',
  score: 0.95,
});

// La mejor versión: sin la palabra "tenis" en el texto ni en las etiquetas; solo el subtema que puso la IA.
const laNacion = (extra = {}) => nota({
  url: 'https://www.lanacion.com.ar/deportes/tenis/thiago-tirante-vencio-al-chileno-alejandro-tabilo-en-estocolmo',
  title: 'Thiago Tirante venció al chileno Alejandro Tabilo en Estocolmo y llegó a su primera final de ATP',
  contentSnippet: 'El argentino Thiago Tirante (53º del ranking mundial) accedió a su primera final del circuito ATP '
    + 'tras vencer al chileno Alejandro Tabilo por 7-5 y 7-6 (1). El platense se medirá con el estadounidense Taylor '
    + 'Fritz, máximo favorito del torneo. El match decisivo será a las 9, de la Argentina.',
  tags: ['atp', 'final', 'tirante'],
  importanceScore: 70,
  geoScope: 'Global',
  publishedAt: new Date('2026-11-13T22:49:46.000Z'),
  sourceName: 'La Nación Deportes',
  score: 0.90,
  ...extra,
});

const olePrevia = () => nota({
  url: 'https://www.ole.com.ar/tenis/thiago-tirante-vs-taylor-fritz-hora-juegan-ver-tv-final-atp-estocolmo',
  title: 'Thiago Tirante vs. Taylor Fritz: a qué hora juegan y dónde ver la final del ATP 250 de Estocolmo',
  contentSnippet: 'Llegó el día más esperado por Thiago Tirante. Jugará su primera final ATP en Estocolmo y se '
    + 'enfrentará al estadounidense Taylor Fritz. La definición se disputará este sábado a las 9.00hs (hora de '
    + 'Argentina) y será transmitida por Disney+ Premium.',
  tags: ['thiago tirante', 'final', 'atp 250'],
  importanceScore: 45,
  contentType: 'previa_agenda',
  publishedAt: new Date('2026-11-13T20:55:14.000Z'),
  sourceName: 'Ole Lo Ultimo',
  score: 0.88,
});

const agendaTv = () => nota({
  url: 'https://www.lanacion.com.ar/deportes/agenda-de-tv-y-streaming-del-sabado',
  title: 'Agenda de TV y streaming del sábado: Boca - Banfield, los Pumas, Tirante y el Abierto de Palermo',
  contentSnippet: 'Todo lo que se puede ver este sábado por TV y streaming.',
  tags: ['agenda', 'tv'],
  topic: 'Fútbol',
  importanceScore: 45,
  contentType: 'previa_agenda',
  publishedAt: new Date('2026-11-13T23:31:05.000Z'),
  score: 0.85,
});

// ---------------------------------------------------------------- motor completo con dependencias falsas
function storeFalso(docs = []) {
  return {
    async listCandidates(q) {
      return docs
        .filter((d) => d.publishedAt >= q.since && d.importanceScore >= q.minImportance
          && (!q.category || d.category === q.category) && (!q.topic || d.topic === q.topic)
          && (!q.excludeTopic || d.topic !== q.excludeTopic))
        .map(({ embedding, ...resto }) => resto); // eslint-disable-line no-unused-vars
    },
    async loadFull(ids) {
      const quiero = new Set(ids.map(String));
      return new Map(docs.filter((d) => quiero.has(String(d._id))).map((d) => [String(d._id), { ...d }]));
    },
    async loadEmbeddings(ids) {
      const quiero = new Set(ids.map(String));
      return new Map(docs.filter((d) => quiero.has(String(d._id))).map((d) => [String(d._id), d.embedding]));
    },
  };
}

async function elegir(topic, candidatos, { now = NOW, docs = [] } = {}) {
  const [r] = await pickBestArticlePerTopic([topic], {
    alreadyShownUrls: [],
    seenEmbeddings: [],
    now,
    deps: {
      search: async () => candidatos.map((d) => ({ ...d })),
      expand: async () => ({ q: 'tenis argentino', cat: 'Deportes', sub: 'Tenis' }),
      store: storeFalso(docs),
      judge: null,
      topicJudge: null,
    },
  });
  return r;
}

// ================================================================ 1. ancla léxica: el subtema de la IA cuenta
test('ancla: la nota de La Nación (sin la palabra "tenis") pasa el ancla gracias al subtema Tenis que le puso la IA', () => {
  assert.equal(matchesAnchors(laNacion(), ['tenis', 'argentino']), true);
});

test('ancla: sin ese subtema la misma nota seguiría afuera (es lo que pasó el 14/11)', () => {
  assert.equal(matchesAnchors(laNacion({ topic: '' }), ['tenis', 'argentino']), false);
});

test('ancla: el subtema no reemplaza a las demás palabras: "argentino" sigue haciendo falta', () => {
  const extranjero = laNacion({
    title: 'Fritz le ganó a Musetti en Estocolmo y jugará la final',
    contentSnippet: 'El estadounidense Taylor Fritz venció al italiano Lorenzo Musetti por 6-4 y 6-2.',
  });
  assert.equal(matchesAnchors(extranjero, ['tenis', 'argentino']), false);
});

test('ancla: en la selección, La Nación queda ACEPTADA (antes: "rechazo: sin ancla léxica")', () => {
  const sel = selectBestCandidate('Tenis Argentino', [perfil(), oleNoticia(), laNacion()], {
    isUsable: (a) => checkEligibility(a, { now: NOW }).ok,
    exhaustive: true,
  });
  assert.deepEqual(sel.anchors, ['tenis', 'argentino']);
  const ln = sel.evaluated.find((r) => r.title.startsWith('Thiago Tirante venció'));
  assert.equal(ln.verdict, 'ACEPTADO');
  assert.equal(sel.accepted.length, 3);
});

// ================================================================ 2. el motor completo
test('motor: a las 8:45 del 14/11 "Tenis Argentino" entrega la versión de La Nación (rival y hora confirmados)', async () => {
  const r = await elegir('Tenis Argentino', [perfil(), oleNoticia(), laNacion(), olePrevia(), agendaTv()]);
  assert.equal(r.article.sourceName, 'La Nación Deportes');
  assert.equal(r.tier, 'buena');
});

test('motor: sin el arreglo del ancla (La Nación sin subtema) se entregaba la de Perfil, la desactualizada', async () => {
  const r = await elegir('Tenis Argentino', [perfil(), oleNoticia(), laNacion({ topic: '' }), olePrevia()]);
  assert.equal(r.article.sourceName, 'Perfil Home');
});
