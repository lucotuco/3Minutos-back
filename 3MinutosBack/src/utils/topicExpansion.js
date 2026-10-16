'use strict';

/**
 * topicExpansion.js
 *
 * Expansión con IA de un tema LIBRE antes de buscarlo. Una sola llamada a gpt-4o-mini devuelve tres cosas:
 *
 *   q    la consulta para la búsqueda por significado: las palabras del usuario + 2-4 palabras específicas
 *        ("river plate" -> "river plate monumental millonario")
 *   cat  la categoría oficial en la que más probablemente caen sus noticias ("Deportes")
 *   sub  el subtema oficial ("Fútbol")
 *
 * cat y sub son una PISTA, no un filtro: el motor la usa para ordenar (entre notas de la misma calidad pasa primero la
 * que la IA de la ingesta etiquetó con ese subtema; "boca" prefiere Fútbol) y nunca para descartar. Se validan contra la
 * taxonomía de officialTopics.js: lo que la IA invente fuera de la lista se descarta ('').
 *
 * Es determinista (temperatura 0 y semilla fija) y barata de repetir:
 *   - caché en memoria con tope y vencimiento (antes un Map que solo crecía)
 *   - llamadas en curso compartidas: si 20 usuarios piden el mismo tema nuevo a la vez, hay UNA llamada (antes, 20)
 *   - si la IA falla, tarda o contesta cualquier cosa, el tema se busca tal cual (sin pista) y NO se guarda el fallo,
 *     así el próximo pedido lo vuelve a intentar.
 */

const { CATEGORIES, ALL_CATEGORIES, TOPIC_TO_CATEGORY, normalizeKey } = require('./officialTopics');
const { TtlCache } = require('./llmJudge');

const EXPANSION_MODEL = 'gpt-4o-mini';
const EXPANSION_TIMEOUT_MS = 8000;
const EXPANSION_MAX_RETRIES = 1;
const EXPANSION_MAX_TOKENS = 120;
const EXPANSION_SEED = 7;
const LONG_TOPIC_WORDS = 5;      // un tema de 5 palabras o más ya es una consulta: no se expande
const MAX_QUERY_CHARS = 200;
const CACHE_TTL_MS = 24 * 3600e3;
const CACHE_MAX_ENTRIES = 2000;

const normalizeText = normalizeKey;

function categoriesForPrompt() {
  return ALL_CATEGORIES.map((cat) => `- ${cat}: ${CATEGORIES[cat].join(', ')}`).join('\n');
}

function buildSystemPrompt(year = new Date().getFullYear()) {
  return [
    `Sos un experto en expansión de consultas para un motor de búsqueda vectorial periodístico (${year}).`,
    'El usuario escribió un tema para recibir noticias. Devolvé SOLO un objeto JSON con tres campos de texto: {"q": "...", "cat": "...", "sub": "..."}',
    '',
    'q = la consulta expandida.',
    'REGLA 1: q DEBE EMPEZAR con las palabras exactas del usuario. NUNCA las elimines ni las modifiques.',
    'REGLA 2: Agregá de 2 a 4 palabras clave muy específicas que ayuden a aislar el tema. Si es un club, su estadio o apodo directo. Si es un político, su partido o cargo. Si es un país, su capital.',
    'REGLA 3: PROHIBICIÓN ABSOLUTA de agregar nombres de rivales, opositores o conceptos contrarios. Si el tema es "River Plate", NO agregues "boca" ni "bosteros".',
    'REGLA 4: NO uses palabras genéricas (deporte, equipo, actualidad, noticias).',
    'q va en minúsculas, en una sola línea, sin comas ni signos de puntuación.',
    '',
    'cat = la categoría de noticias a la que más probablemente pertenece el tema. Una de estas, escrita igual, con su lista de subtemas:',
    categoriesForPrompt(),
    'sub = el subtema de esa categoría que mejor describe el tema, escrito igual que en la lista.',
    'Si no estás seguro de cat o de sub, dejalo en "" (texto vacío). Nunca inventes categorías ni subtemas.',
  ].join('\n');
}

// ---------------------------------------------------------------- lectura de la respuesta
/** Categoría oficial con su escritura exacta ("deportes" -> "Deportes"), o ''. Solo vale un texto (un 7 o una lista, no). */
function validCategory(value) {
  if (typeof value !== 'string') return '';
  const key = normalizeText(value);
  return ALL_CATEGORIES.find((cat) => normalizeText(cat) === key) || '';
}

/** Subtema oficial de `cat` con su escritura exacta ("futbol" -> "Fútbol"), o ''. Solo vale un texto. */
function validSubtopic(value, cat) {
  if (typeof value !== 'string') return '';
  const key = normalizeText(value);
  if (!key) return '';
  const pool = cat ? CATEGORIES[cat] : [...TOPIC_TO_CATEGORY.keys()];
  return pool.find((sub) => normalizeText(sub) === key) || '';
}

const PUNCTUATION = /[,;:.!?¿¡"'`()[\]{}]/g;

/** Minúsculas, una línea, sin signos de puntuación. */
const tidy = (value) => String(value ?? '').toLowerCase().replace(PUNCTUATION, ' ').split(/\s+/).filter(Boolean).join(' ');

/**
 * La consulta limpia: minúsculas, una línea, sin comas ni signos; siempre empieza con las palabras del usuario
 * (regla 1: si la IA las cambió, se las antepone) y nunca pasa de MAX_QUERY_CHARS.
 */
function cleanQuery(rawQuery, topic) {
  let query = tidy(rawQuery);
  if (!query) return topic;
  const typed = tidy(topic) || String(topic).toLowerCase();
  // Palabra entera: "river platense ..." NO empieza con "river plate".
  if (!`${normalizeText(query)} `.startsWith(`${normalizeText(typed)} `)) query = `${typed} ${query}`;
  if (query.length > MAX_QUERY_CHARS) query = query.slice(0, MAX_QUERY_CHARS).replace(/\s+\S*$/, '');
  return query;
}

/**
 * Respuesta de la IA -> { q, cat, sub } validado; null si no es un JSON que se pueda usar.
 * cat y sub siempre son de la taxonomía oficial o ''. Un subtema sin categoría completa la categoría; un subtema que
 * pertenece a otra categoría que la dicha se descarta (la categoría manda).
 */
function parseExpansion(text, topic) {
  let data;
  try {
    // Con response_format json_object la IA devuelve JSON puro; por las dudas se toleran las vallas de código.
    data = JSON.parse(String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.q !== 'string') return null;

  let cat = validCategory(data.cat);
  const sub = validSubtopic(data.sub, cat || null);
  if (sub && !cat) cat = TOPIC_TO_CATEGORY.get(sub) || '';
  return { q: cleanQuery(data.q, topic), cat, sub };
}

/** Sea lo que sea que devuelva una expansión (un texto, como en los tests viejos, o { q, cat, sub }): { q, cat, sub }. */
function asExpansion(value, topic) {
  if (value && typeof value === 'object') {
    return { q: String(value.q || topic), cat: String(value.cat || ''), sub: String(value.sub || '') };
  }
  return { q: String(value || topic), cat: '', sub: '' };
}

function defaultClient() {
  // Carga perezosa: config/openai exige las claves al importarse y los tests no las tienen.
  return require('../config/openai').openaiReview;
}

// ---------------------------------------------------------------- el expansor
/**
 * Arma un expansor con su propia caché (los tests le pasan un cliente falso y un reloj).
 * @returns {{ expand:(topic:string)=>Promise<{q:string,cat:string,sub:string}>, cache:TtlCache, inflight:Map }}
 */
function createTopicExpander({
  getClient = defaultClient,
  now = Date.now,
  log = (m) => console.log(m),
  warn = (m, e) => console.warn(m, e),
  cacheTtlMs = CACHE_TTL_MS,
  cacheMaxEntries = CACHE_MAX_ENTRIES,
} = {}) {
  const cache = new TtlCache({ maxEntries: cacheMaxEntries, ttlMs: cacheTtlMs, now });
  const inflight = new Map();

  async function askModel(topic) {
    const response = await getClient().chat.completions.create(
      {
        model: EXPANSION_MODEL,
        messages: [
          { role: 'system', content: buildSystemPrompt(new Date(now()).getFullYear()) },
          { role: 'user', content: topic },
        ],
        temperature: 0,
        seed: EXPANSION_SEED,
        max_tokens: EXPANSION_MAX_TOKENS,
        response_format: { type: 'json_object' },
      },
      { timeout: EXPANSION_TIMEOUT_MS, maxRetries: EXPANSION_MAX_RETRIES },
    );
    const parsed = parseExpansion(response?.choices?.[0]?.message?.content, topic);
    if (!parsed) throw new Error('la IA no devolvió un JSON con q');
    return parsed;
  }

  async function expand(rawTopic) {
    const topic = String(rawTopic || '').trim();
    const plain = { q: topic, cat: '', sub: '' };
    if (!topic) return plain;
    if (topic.split(/\s+/).length >= LONG_TOPIC_WORDS) return plain;

    const key = normalizeText(topic).replace(/\s+/g, ' '); // "River  Plate" y "river plate" son el mismo tema
    const cached = cache.get(key);
    if (cached) return { ...cached };
    if (inflight.has(key)) return { ...(await inflight.get(key)) };

    const pending = (async () => {
      try {
        const value = await askModel(topic);
        cache.set(key, value);
        log(`[Query Expansion IA] "${topic}" -> "${value.q}" | categoría: ${value.cat || '-'} | subtema: ${value.sub || '-'}`);
        return value;
      } catch (error) {
        warn(`Fallo expansion IA para "${topic}", usando original:`, error.message);
        return plain; // el fallo no se guarda: el próximo pedido vuelve a intentar
      }
    })();
    inflight.set(key, pending);
    try {
      return { ...(await pending) };
    } finally {
      inflight.delete(key);
    }
  }

  return { expand, cache, inflight };
}

const defaultExpander = createTopicExpander();

module.exports = {
  EXPANSION_MODEL,
  EXPANSION_TIMEOUT_MS,
  EXPANSION_MAX_RETRIES,
  LONG_TOPIC_WORDS,
  MAX_QUERY_CHARS,
  CACHE_TTL_MS,
  CACHE_MAX_ENTRIES,
  buildSystemPrompt,
  validCategory,
  validSubtopic,
  cleanQuery,
  parseExpansion,
  asExpansion,
  createTopicExpander,
  expandTopic: defaultExpander.expand,
  expansionCache: defaultExpander.cache,
};
