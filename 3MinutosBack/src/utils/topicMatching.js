/**
 * topicMatching.js
 *
 * Lógica PURA (sin Mongo, sin OpenAI) para decidir si un candidato de la búsqueda
 * híbrida realmente corresponde al tema libre que escribió el usuario.
 *
 * Reemplaza dos cosas de pickBestArticlePerTopic:
 *   - mirar solo el primer candidato;
 *   - exigir que TODAS las palabras del tema estén en el texto ("river plate" vs
 *     una prensa que escribe solo "River").
 *
 * Todo se deriva de los candidatos que devolvió la propia búsqueda: no hay listas
 * de nombres propios ni de equipos.
 */

const { toPlainText } = require('./plainText');

const VERDE_MIN = 0.94;
const AMARILLA_MIN = 0.80;

// Candidatos que "votan" para inferir ancla léxica y categoría.
const POOL_MIN_SCORE = AMARILLA_MIN;
const POOL_MAX_SIZE = 10;
const POOL_MIN_SIZE = 3;

// Una palabra del tema es "ancla" si aparece al menos en esta fracción de los
// documentos de la palabra más frecuente del tema.
const ANCHOR_RELATIVE_DF = 0.5;
const ANCHOR_MIN_DOCS = 2;

// Categoría "corral": debe concentrar al menos esta fracción del puntaje del pool.
const CORRAL_MIN_SHARE = 0.6;

// Solo palabras funcionales del español (no hay nombres propios acá).
const FUNCTION_WORDS = new Set([
  'del', 'los', 'las', 'una', 'uno', 'unos', 'unas', 'con', 'sin', 'por', 'para',
  'que', 'como', 'sus', 'este', 'esta', 'esto', 'ese', 'esa', 'son', 'ser',
]);

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function tokenize(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

function topicWords(topic) {
  const seen = new Set();
  return tokenize(topic).filter((w) => {
    if (w.length < 3 || FUNCTION_WORDS.has(w) || seen.has(w)) return false;
    seen.add(w);
    return true;
  });
}

function articleTokenSet(article) {
  // El resumen se limpia antes de partirlo en palabras: en una nota guardada con HTML, "auth", "smart", "width",
  // "height" o "div" contaban como palabras de la nota (y "composici" / "xf3" como trozos de una palabra con tilde).
  const text = [
    article?.title,
    toPlainText(article?.rawSummary),
    toPlainText(article?.contentSnippet),
    ...(Array.isArray(article?.tags) ? article.tags : []),
  ].join(' ');
  return new Set(tokenize(text));
}

function zoneOf(score) {
  if (score >= VERDE_MIN) return 'VERDE';
  if (score >= AMARILLA_MIN) return 'AMARILLA';
  return 'ROJA';
}

function buildPool(candidates) {
  return candidates
    .filter((a) => (a.score || 0) >= POOL_MIN_SCORE)
    .slice(0, POOL_MAX_SIZE);
}

/**
 * Palabras del tema que los medios realmente usan para este tema, medidas sobre
 * el pool de candidatos. "river plate" -> ['river'] porque la prensa casi nunca
 * escribe "plate". Si el pool es chico, no hay evidencia: se exigen todas las
 * palabras (comportamiento estricto, igual que antes).
 */
function extractAnchorWords(topic, pool) {
  const words = topicWords(topic);
  if (words.length <= 1) return { words, anchors: words, mode: 'single', evidence: false };
  if (pool.length < POOL_MIN_SIZE) return { words, anchors: words, mode: 'strict_no_pool', evidence: false };

  const sets = pool.map(articleTokenSet);
  const df = new Map(words.map((w) => [w, sets.filter((s) => s.has(w)).length]));
  const maxDf = Math.max(...df.values());

  if (maxDf < ANCHOR_MIN_DOCS) {
    return { words, anchors: words, mode: 'strict_no_support', evidence: false };
  }

  const threshold = Math.max(ANCHOR_MIN_DOCS, Math.ceil(maxDf * ANCHOR_RELATIVE_DF));
  const anchors = words.filter((w) => df.get(w) >= threshold);
  return { words, anchors, mode: 'pool_df', evidence: true, df: Object.fromEntries(df) };
}

function matchesAnchors(article, anchors) {
  if (!anchors.length) return false;
  const tokens = articleTokenSet(article);
  return anchors.every((w) => tokens.has(w));
}

/**
 * Categoría dominante entre los mejores candidatos, ponderada por score.
 * Devuelve null si no hay evidencia suficiente (tema ambiguo o pool chico).
 */
function inferCorralCategory(pool) {
  if (pool.length < POOL_MIN_SIZE) return null;
  const weights = new Map();
  let total = 0;
  for (const a of pool) {
    if (!a.category) continue;
    const w = a.score || 0;
    weights.set(a.category, (weights.get(a.category) || 0) + w);
    total += w;
  }
  if (total === 0) return null;
  const [bestCat, bestW] = [...weights.entries()].sort((x, y) => y[1] - x[1])[0];
  return bestW / total >= CORRAL_MIN_SHARE ? bestCat : null;
}

/**
 * Recorre los candidatos EN ORDEN y devuelve el primero que pasa.
 *
 * @param {string}   topic
 * @param {object[]} candidates  salida de searchArticlesBySimilarityAtlas (con .score y .category)
 * @param {object}   opts
 * @param {(a:object)=>boolean} [opts.isUsable]  filtro de duplicados / edad / opinión
 * @param {string|null} [opts.strictCategory]    corral fijo (tópicos oficiales); si viene, no se infiere
 * @param {boolean} [opts.exhaustive]            evalúa todos; por defecto corta en el primero válido
 * @param {boolean} [opts.softCorral]            el corral deja de descartar: una nota de otra categoría se acepta marcada
 *                                               `outOfCorral` y la decide el juez de tema (topicJudge.js). Sin juez el
 *                                               corral sigue siendo un descarte duro.
 *
 * Devuelve además `accepted`: TODOS los candidatos aceptados, cada uno con su zona, su score, su
 * posición (`rank`, desde 1) en la lista original y `outOfCorral`. Con exhaustive=true el motor reordena `accepted`
 * por calidad (eligibility.js) en vez de quedarse con el primero que dejó la búsqueda.
 */
function selectBestCandidate(topic, candidates, {
  isUsable = () => true, strictCategory = null, exhaustive = false, softCorral = false,
} = {}) {
  const pool = buildPool(candidates);
  const { anchors, mode } = extractAnchorWords(topic, pool);
  const corral = strictCategory || inferCorralCategory(pool);

  const evaluated = [];
  const accepted = [];
  let picked = null;
  let rank = 0;

  for (const a of candidates) {
    rank++;
    const score = a.score || 0;
    const zone = zoneOf(score);
    const row = { title: a.title, score, zone, category: a.category, verdict: null };
    evaluated.push(row);

    if (zone === 'ROJA') { row.verdict = 'rechazo: score bajo'; continue; }
    if (!isUsable(a)) { row.verdict = 'rechazo: ya visto/vencido/opinión'; continue; }
    const outOfCorral = Boolean(corral && a.category && a.category !== corral);
    if (outOfCorral && !softCorral) { row.verdict = `rechazo: fuera del corral ${corral}`; continue; }

    if (zone === 'AMARILLA' && !matchesAnchors(a, anchors)) {
      row.verdict = `rechazo: sin ancla léxica [${anchors.join(', ')}]`;
      continue;
    }

    row.verdict = outOfCorral ? `ACEPTADO (fuera del corral ${corral}: lo decide el juez)` : 'ACEPTADO';
    accepted.push({ article: a, zone, score, rank, outOfCorral });
    if (!picked) picked = { article: a, zone, score };
    if (!exhaustive) break;
  }

  return {
    ...(picked || { article: null, zone: null, score: null }),
    corral,
    anchors,
    anchorMode: mode,
    candidatesEvaluated: evaluated.length,
    evaluated,
    accepted,
  };
}

module.exports = {
  VERDE_MIN,
  AMARILLA_MIN,
  zoneOf,
  topicWords,
  extractAnchorWords,
  matchesAnchors,
  inferCorralCategory,
  selectBestCandidate,
};
