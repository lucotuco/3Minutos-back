/**
 * freshness.js - UNICA fuente de verdad para "frescura" y notas de previa/agenda.
 * Antes habia dos curvas distintas (articleRanking.js y searchArticlesBySimilarityAtlas.js)
 * y la lista de palabras de previa estaba copiada en ambos archivos.
 */

// Antigüedad MAXIMA (horas) de una nota en el digest, medida cuando el usuario la VE.
// La app no muestra la edad de la nota: una nota vieja parece nueva. Por eso es un tope duro.
// Lo usan el filtro de la busqueda (minDate), la elegibilidad (eligibility.js) y la revision
// del digest guardado al abrirlo (staleDigest.js). NO afecta a FRESHNESS_CURVE (ranking del listado).
const MAX_ARTICLE_AGE_HOURS = 24;

// Antigüedad IDEAL (horas): hasta aca la nota es "fresca" y va antes que una de entre 10 y 24 h.
const IDEAL_ARTICLE_AGE_HOURS = 8;

// Curva de frescura (0-100): premia fuerte lo de hoy sin matar lo de anoche.
const FRESHNESS_CURVE = [
  [2, 100],   // recien salido del horno
  [6, 90], 
  [8,80]   // muy fresco
  [10, 70],
  [12, 60],
  [18, 70],
  [24, 30],   // hace un dia
];

const PREVIEW_OR_AGENDA_KEYWORDS = [
  'en vivo', 'a que hora', 'donde ver', 'minuto a minuto', 'formaciones',
  'agenda de partidos', 'partidos de hoy', 'que canal', 'tabla de posiciones', 'fixture',
];

// Marcas de "previa" como genero periodistico: "(Previa) ...", "Previa: ...", "Previa del ...".
// A proposito NO se busca la palabra suelta ni "previa:" en el medio del titulo: "en la previa de
// una huelga", "la accion previa al 1-0" o "Autorizacion previa: ..." son noticias reales
// (en la muestra de auditoria aparecen 4 asi contra 3 previas de verdad).
const PREVIEW_MARKERS = [
  /^\s*previa\b/,        // el titulo empieza con "Previa" ("Previa: ...", "Previa del ...", "Previa LNB: ...")
  /\(\s*previa\s*\)/,    // "(Previa)"
];

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function getHoursSince(date) {
  if (!date) return 9999;
  const published = new Date(date).getTime();
  if (Number.isNaN(published)) return 9999;
  return Math.max(0, (Date.now() - published) / (1000 * 60 * 60));
}

/** Frescura 0-100. Sin fecha o mas de una semana: 0. */
function getFreshnessScore(publishedAt) {
  const hours = getHoursSince(publishedAt);
  for (const [maxHours, score] of FRESHNESS_CURVE) {
    if (hours <= maxHours) return score;
  }
  return 0;
}

/** true si el titulo es de previa/agenda/en vivo (pierde valor rapido). */
function isPreviewOrAgenda(title) {
  const t = normalize(title);
  return PREVIEW_OR_AGENDA_KEYWORDS.some((kw) => t.includes(kw)) || PREVIEW_MARKERS.some((re) => re.test(t));
}

module.exports = {
  MAX_ARTICLE_AGE_HOURS,
  IDEAL_ARTICLE_AGE_HOURS,
  getHoursSince,
  getFreshnessScore,
  isPreviewOrAgenda,
};
