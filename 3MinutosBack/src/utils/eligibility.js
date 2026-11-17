'use strict';

/**
 * eligibility.js
 *
 * Lógica PURA (sin Mongo, sin OpenAI) que decide si una nota PUEDE entregarse y en qué orden.
 * Reemplaza a isUsableDigestArticle (que solo miraba URL, opinión, 48 h y un filtro semántico
 * que nunca corría) y al "puntaje mezclado" como criterio de elección entre notas válidas.
 *
 * Una nota es elegible solo si cumple TODO esto:
 *   1. vigente        publishedAt dentro de MAX_ARTICLE_AGE_HOURS (24 h) y con fecha creíble
 *   2. sustancia      importanceScore >= 40 (>= 50 = "buena", 40-49 = "aceptable")
 *   3. país           en Sociedad, geoScope Argentina o Global (Política/Economía ya lo garantiza la ingesta)
 *   4. no opinión     ni columnas ni editoriales (por la URL, el título, las etiquetas o el tipo que dijo la IA)
 *      ni publicidad  ni contenido patrocinado ("In House") ni notas de servicio (tutoriales, "dónde ver", recetas)
 *   5. no previa      ni agenda ni "en vivo" ni minuto a minuto
 *   6. no repetida    URL no vista, y no es "la misma historia" que algo visto en 48 h ni que algo ya elegido
 *                     (coseno >= 0,88; entre 0,80 y 0,88 decide el juez de sameEventJudge.js)
 *
 * Entre las elegibles el orden es: nivel (buena antes que aceptable) -> [pista de subtema, solo temas libres] ->
 * puntaje (importancia y frescura ponderadas, ver deliveryScore) -> más nueva -> _id (desempate estable).
 *
 * La zona de similitud de la búsqueda (VERDE / AMARILLA) NO ordena: sale del puesto que ocupó la nota en dos listas
 * (puntaje por posición, no por parecido real), así que dos notas de calidad muy distinta quedaban separadas por un
 * escalón arbitrario. La relevancia la deciden el ancla léxica, el corral y el juez de tema; el orden, la calidad.
 */

const { MAX_ARTICLE_AGE_HOURS, FRESHNESS_WEIGHT, freshnessOfAge, isPreviewOrAgenda } = require('./freshness');
const { exclusionReasonOf } = require('./contentTypes');

// ---------------------------------------------------------------- umbrales
const IMPORTANCE_GOOD_MIN = 50;        // >= 50: nota "buena"
const IMPORTANCE_ACCEPTABLE_MIN = 40;  // 40-49: "aceptable" (solo si no hay una buena)
const SAME_STORY_COSINE = 0.88;        // coseno entre embeddings de notas: >= esto es la misma historia
// Por debajo de 0,88 también hay notas que cuentan el MISMO hecho con otras palabras (otro medio, otro enfoque).
// En la banda [0,80; 0,88) el coseno no alcanza para decidir y se le pregunta al juez (sameEventJudge.js);
// por debajo de 0,80 son hechos distintos. El borde de 0,80 es una estimación: se afina con tests/medirCosenos.js,
// que muestra el coseno real de las notas repetidas de un reporte.
const SAME_STORY_JUDGE_MIN_COSINE = 0.80;

// En el RESCATE la banda del juez empieza más abajo. Una nota sugerida ya es un premio consuelo: si además cuenta
// algo que el lector ya vio en este mismo digest (o en un refresco anterior), no aporta nada. Y es justo donde pasa:
// el rescate lee toda la categoría y entrega lo más importante y fresco, que para dos tópicos distintos del mismo
// rubro suele ser el MISMO hecho (dos notas del Balón de Oro, una para "boca juniors" y otra para "river plate").
// Dos notas del mismo evento con enfoques distintos se quedan por debajo de 0,80 de coseno y se escapaban; desde
// 0,70 las mira el juez, que es el que sabe decidir si es el mismo hecho.
const RESCUE_JUDGE_MIN_COSINE = 0.70;

const JUDGE_MAX_PAIRS_PER_CANDIDATE = 2; // contra cuántas notas vistas se compara una candidata como máximo
const MAX_FUTURE_SKEW_HOURS = 3;       // una fecha más de 3 h en el futuro no es creíble

// Cuánto mira hacia atrás el historial de lo que el usuario ya vio (getAlreadyShownUrlsForUser.js).
// Una nota vista hace más de 24 h ya no podría elegirse por edad; 48 h cubre además las notas nuevas
// de una MISMA historia que salen al día siguiente. El tope de notas acota el costo de traer embeddings.
const HISTORY_WINDOW_HOURS = 48;
const HISTORY_MAX_NOTES = 150;

// Categorías "de vida local": solo notas de Argentina o de alcance Global.
// Política y Economía no están: la ingesta ya pasa a Internacional las que tienen país extranjero.
const LOCAL_ONLY_CATEGORIES = new Set(['sociedad']);
const LOCAL_SCOPES = new Set(['argentina', 'global']);

const TIER = Object.freeze({ GOOD: 'buena', ACCEPTABLE: 'aceptable' });
const TIER_RANK = { [TIER.GOOD]: 0, [TIER.ACCEPTABLE]: 1 };

// Opinión y publicidad se reconocen por PALABRA COMPLETA, nunca por "contiene": con "contiene", un título como
// "Análisis de sangre: qué mide", "La opinión pública y la inflación" o "Editorial Planeta lanzó..." quedaba
// descartado, y a la vez no se reconocía "/columnistas/" porque nadie había pensado en esa palabra.

// Segmentos de la ruta de la URL (igualdad exacta con el segmento entero, sin la última parte, que es el
// título de la nota). Salen de las notas que de verdad se colaron en los reportes: /columnistas/ (Perfil, El
// Cronista), /ambito-debate/ (Ámbito), /cartas-al-pais/ (Clarín).
const OPINION_URL_SEGMENTS = new Set([
  'opinion', 'opiniones', 'columna', 'columnas', 'columnista', 'columnistas',
  'editorial', 'editoriales', 'cartas-al-pais', 'ambito-debate',
]);
// Contenido pago de un anunciante, presentado como nota (Infobae lo publica bajo /inhouse/).
const ADVERTISING_URL_SEGMENTS = new Set(['inhouse']);
// Etiquetas, sección y subtema: solo si SON la palabra (la IA etiqueta "opinión", no "opinión pública").
const OPINION_LABELS = new Set(['opinion', 'columna', 'editorial', 'columnista', 'columna de opinion']);
// Marca de género al principio del título: "Opinión: ...", "Columna | ...", "Análisis - ...".
const OPINION_TITLE_MARKER = /^(?:opinion|columna|editorial|analisis)\s*[:|\-–—]/;

// ---------------------------------------------------------------- utilidades
function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Coseno entre dos vectores. 0 si falta alguno, si el largo no coincide o si alguno es nulo. */
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Edad en horas (null si no hay fecha válida). Puede ser negativa si la fecha está en el futuro. */
function ageHoursOf(article, now = Date.now()) {
  if (!article?.publishedAt) return null;
  const t = new Date(article.publishedAt).getTime();
  if (Number.isNaN(t)) return null;
  return (now - t) / 3600000;
}

function importanceOf(article) {
  const n = Number(article?.importanceScore);
  return Number.isFinite(n) ? n : 0;
}

/** 'buena' (>= 50) | 'aceptable' (40-49) | null (< 40). */
function tierOf(importance) {
  if (importance >= IMPORTANCE_GOOD_MIN) return TIER.GOOD;
  if (importance >= IMPORTANCE_ACCEPTABLE_MIN) return TIER.ACCEPTABLE;
  return null;
}

/**
 * Puntaje de entrega 0-100: (1 - peso) * importancia + peso * frescura, con la frescura de freshnessOfAge: 100 hasta
 * la meseta (4 h por defecto, ahí da igual cuántos minutos tenga la nota) y después lineal hasta 0 (24 h).
 * Reemplaza al corte "hasta N h primero": no hay escalón, cada punto de importancia y cada hora pasada la meseta
 * cuentan, y para dar más valor a la frescura se sube FRESHNESS_WEIGHT.
 * @param {number} importance  importanceScore de la nota (0-100)
 * @param {number} ageHours    edad en horas (negativa = recién publicada)
 * @param {number} [weight]    peso de la frescura, 0-1 (por defecto FRESHNESS_WEIGHT)
 */
function deliveryScore(importance, ageHours, weight = FRESHNESS_WEIGHT) {
  return (1 - weight) * importance + weight * freshnessOfAge(ageHours);
}

// ---------------------------------------------------------------- opinión y publicidad
/** Segmentos de la ruta de una URL, sin acentos ni mayúsculas, sin el último (el título de la nota). */
function urlSectionSegments(rawUrl) {
  const raw = String(rawUrl || '').trim();
  if (!raw) return [];
  let path;
  try {
    path = new URL(raw).pathname;
  } catch {
    path = raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').split(/[?#]/)[0];
  }
  const segments = path.split('/').filter(Boolean).map((segment) => {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch { /* segmento con % mal formado: se compara tal cual */ }
    return normalizeText(decoded);
  });
  return segments.length > 1 ? segments.slice(0, -1) : segments;
}

function isOpinionArticle(article = {}) {
  if (urlSectionSegments(article.url).some((segment) => OPINION_URL_SEGMENTS.has(segment))) return true;
  // La sección solo existe si el adaptador la completa (hoy ninguno); la categoría es una lista fija y no se mira.
  if (OPINION_LABELS.has(normalizeText(article.section))) return true;
  if (OPINION_LABELS.has(normalizeText(article.topic))) return true;
  const tags = Array.isArray(article.tags) ? article.tags : [];
  if (tags.some((tag) => OPINION_LABELS.has(normalizeText(tag)))) return true;
  return OPINION_TITLE_MARKER.test(normalizeText(article.title));
}

/** true si la nota es contenido patrocinado presentado como nota. */
function isAdvertisingArticle(article = {}) {
  return urlSectionSegments(article.url).some((segment) => ADVERTISING_URL_SEGMENTS.has(segment));
}

// ---------------------------------------------------------------- país
/** true si la nota es de una categoría "local" pero el alcance que le puso la IA es de otro país. */
function isForeignInLocalCategory(article) {
  if (!LOCAL_ONLY_CATEGORIES.has(normalizeText(article?.category))) return false;
  const scope = normalizeText(article?.geoScope);
  if (!scope) return false; // sin dato: la ingesta lo deja en 'Global' por defecto
  return !LOCAL_SCOPES.has(scope);
}

// ---------------------------------------------------------------- misma historia
/**
 * Mayor parecido del embedding de la nota contra los vistos.
 * @param {number[]} embedding
 * @param {{title?:string, vector:number[]}[]} seen
 * @returns {{similarity:number, title:string|null}}
 */
function mostSimilarSeen(embedding, seen = []) {
  let best = { similarity: 0, title: null };
  if (!Array.isArray(embedding) || embedding.length === 0) return best;
  for (const s of seen) {
    const sim = cosine(embedding, s?.vector);
    if (sim > best.similarity) best = { similarity: sim, title: s?.title ?? null };
  }
  return best;
}

/** { similarity, title } si la nota es "la misma historia" que algo visto; null si no (o si no hay embedding). */
function findSameStory(embedding, seen = [], threshold = SAME_STORY_COSINE) {
  const best = mostSimilarSeen(embedding, seen);
  return best.similarity >= threshold ? best : null;
}

/**
 * Las notas vistas que caen en la banda del juez: coseno en [min, max). Las más parecidas primero, hasta `limit`.
 * Devuelve [{ similarity, entry }] con la entrada completa de `seen` (id, título y bajada para la pregunta).
 */
function seenInJudgeBand(embedding, seen = [], {
  min = SAME_STORY_JUDGE_MIN_COSINE, max = SAME_STORY_COSINE, limit = JUDGE_MAX_PAIRS_PER_CANDIDATE,
} = {}) {
  if (!Array.isArray(embedding) || embedding.length === 0) return [];
  const near = [];
  for (const entry of seen) {
    const similarity = cosine(embedding, entry?.vector);
    if (similarity >= min && similarity < max) near.push({ similarity, entry });
  }
  near.sort((a, b) => b.similarity - a.similarity);
  return near.slice(0, limit);
}

// ---------------------------------------------------------------- elegibilidad
/**
 * Chequeos baratos (no necesitan embedding). La comparación "misma historia" va aparte
 * (findSameStory) porque el embedding se trae solo para los finalistas.
 *
 * @param {object} article
 * @param {object} [ctx]
 * @param {number} [ctx.now]          epoch ms (por defecto, ahora)
 * @param {Set<string>} [ctx.usedUrls] URLs ya vistas o ya elegidas
 * @returns {{ok:boolean, tier:string|null, ageHours:number|null, importance:number, reasons:string[]}}
 */
function checkEligibility(article, { now = Date.now(), usedUrls = new Set() } = {}) {
  const reasons = [];
  const importance = importanceOf(article);
  const ageHours = ageHoursOf(article, now);
  const tier = tierOf(importance);

  if (!article?.url) reasons.push('sin_url');
  else if (usedUrls.has(article.url)) reasons.push('url_repetida');

  if (ageHours === null) reasons.push('sin_fecha');
  else if (ageHours > MAX_ARTICLE_AGE_HOURS) reasons.push('vencida');
  else if (ageHours < -MAX_FUTURE_SKEW_HOURS) reasons.push('fecha_futura');

  if (!tier) reasons.push('importancia_baja');
  if (isForeignInLocalCategory(article)) reasons.push('otro_pais');
  if (isOpinionArticle(article)) reasons.push('opinion');
  if (isAdvertisingArticle(article)) reasons.push('publicidad');
  if (isPreviewOrAgenda(article?.title)) reasons.push('previa_o_agenda');
  // El tipo que dijo el clasificador (opinion, servicio, previa_agenda, publicidad). Las notas anteriores a ese
  // campo no lo tienen y se tratan como noticia. Si la URL o el título ya dieron el mismo motivo, no se repite.
  const typeReason = exclusionReasonOf(article?.contentType);
  if (typeReason && !reasons.includes(typeReason)) reasons.push(typeReason);

  return {
    ok: reasons.length === 0,
    tier,
    ageHours,
    importance,
    reasons,
  };
}

// ---------------------------------------------------------------- orden
/**
 * Comparador de candidatos ya elegibles. Cada entrada: { article, tier, hint?, score?, ageHours, importance }.
 *   1. nivel      buena antes que aceptable
 *   2. pista      (solo temas libres) 2 = la nota tiene el subtema que se esperaba del tema, 1 = solo la categoría, 0 = ninguna;
 *                 la mayor primero. Sin pista (temas oficiales) no desempata.
 *   3. puntaje    deliveryScore (importancia y frescura ponderadas): el mayor primero. Si la entrada no trae `score`
 *                 se calcula con su importancia y su edad.
 *   4. edad       la más nueva primero (desempata puntajes iguales)
 *   5. _id        desempate estable (mismo resultado con los mismos datos)
 */
function compareCandidates(a, b) {
  const byTier = (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9);
  if (byTier) return byTier;

  const byHint = (b.hint || 0) - (a.hint || 0);
  if (byHint) return byHint;

  const scoreA = a.score ?? deliveryScore(a.importance, a.ageHours);
  const scoreB = b.score ?? deliveryScore(b.importance, b.ageHours);
  if (scoreA !== scoreB) return scoreB - scoreA;
  if (a.ageHours !== b.ageHours) return a.ageHours - b.ageHours;

  const idA = String(a.article?._id ?? a.article?.url ?? '');
  const idB = String(b.article?._id ?? b.article?.url ?? '');
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}

/**
 * Cuánto coincide una nota con la pista { cat, sub } de la expansión del tema: 2 = mismo subtema (y categoría),
 * 1 = misma categoría, 0 = ninguna o sin pista. Es una pista de orden, nunca un filtro.
 */
function hintLevel(article, hint) {
  if (!hint || (!hint.cat && !hint.sub)) return 0;
  const sameCategory = !hint.cat || normalizeText(article?.category) === normalizeText(hint.cat);
  if (hint.sub && normalizeText(article?.topic) === normalizeText(hint.sub) && sameCategory) return 2;
  if (hint.cat && normalizeText(article?.category) === normalizeText(hint.cat)) return 1;
  return 0;
}

/**
 * Evalúa y ordena una lista de notas. Devuelve las elegibles ordenadas y, aparte, las descartadas
 * con el motivo (para trazabilidad y tests).
 *
 * @param {object[]} articles
 * @param {object} ctx            igual que checkEligibility
 * @param {object} [opts]
 * @param {(a:object)=>string|null} [opts.zoneOf]  zona de similitud de cada nota (temas libres); solo informativa, no ordena
 * @param {(a:object)=>number} [opts.hintOf]       nivel de pista de subtema de cada nota, 0-2 (temas libres); ordena
 * @param {boolean} [opts.goodOnly]               solo nivel "buena" (rescate)
 */
function rankEligible(articles, ctx = {}, { zoneOf = null, hintOf = null, goodOnly = false } = {}) {
  const eligible = [];
  const rejected = [];
  for (const article of articles || []) {
    const ev = checkEligibility(article, ctx);
    if (!ev.ok) {
      rejected.push({ article, reasons: ev.reasons });
      continue;
    }
    if (goodOnly && ev.tier !== TIER.GOOD) {
      rejected.push({ article, reasons: ['no_es_buena'] });
      continue;
    }
    const ageHours = Math.max(0, ev.ageHours);
    eligible.push({
      article,
      tier: ev.tier,
      zone: zoneOf ? zoneOf(article) : null,
      hint: hintOf ? hintOf(article) : 0,
      ageHours,
      importance: ev.importance,
      score: deliveryScore(ev.importance, ageHours),
    });
  }
  eligible.sort(compareCandidates);
  return { eligible, rejected };
}

module.exports = {
  IMPORTANCE_GOOD_MIN,
  IMPORTANCE_ACCEPTABLE_MIN,
  SAME_STORY_COSINE,
  SAME_STORY_JUDGE_MIN_COSINE,
  RESCUE_JUDGE_MIN_COSINE,
  JUDGE_MAX_PAIRS_PER_CANDIDATE,
  MAX_FUTURE_SKEW_HOURS,
  HISTORY_WINDOW_HOURS,
  HISTORY_MAX_NOTES,
  LOCAL_ONLY_CATEGORIES,
  TIER,
  OPINION_URL_SEGMENTS,
  ADVERTISING_URL_SEGMENTS,
  normalizeText,
  cosine,
  ageHoursOf,
  importanceOf,
  tierOf,
  deliveryScore,
  isOpinionArticle,
  isAdvertisingArticle,
  isForeignInLocalCategory,
  mostSimilarSeen,
  findSameStory,
  seenInJudgeBand,
  checkEligibility,
  compareCandidates,
  hintLevel,
  rankEligible,
};
