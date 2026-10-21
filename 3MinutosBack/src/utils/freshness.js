/**
 * freshness.js - UNICA fuente de verdad para "frescura" y notas de previa/agenda.
 * Antes habia dos curvas distintas (articleRanking.js y searchArticlesBySimilarityAtlas.js)
 * y la lista de palabras de previa estaba copiada en ambos archivos.
 */

// Antigüedad MAXIMA (horas) de una nota en el digest, medida cuando el usuario la VE.
// La app no muestra la edad de la nota: una nota vieja parece nueva. Por eso es un tope duro.
// Lo usan el filtro de la busqueda (minDate), la elegibilidad (eligibility.js) y la revision
// del digest guardado al abrirlo (staleDigest.js). NO afecta a FRESHNESS_CURVE (ranking del listado).
// freshnessOfAge (abajo) la usa como fin de la escala: a esa edad la frescura es 0 (y la meseta tiene que ser menor).
const MAX_ARTICLE_AGE_HOURS = 24;

// Peso de la frescura (0-1) al ORDENAR lo que se entrega (eligibility.js):
//   puntaje = (1 - peso) * importancia + peso * frescura
// 0 = solo importancia, 1 = solo frescura. Se ajusta sin tocar codigo con FRESHNESS_WEIGHT (ej. 0.4);
// un valor invalido o fuera de 0-1 vuelve al valor por defecto.
// Ojo: importancia y frescura no varian igual entre notas del mismo tema (en la muestra de auditoria la
// frescura se dispersa ~3 veces mas que la importancia), asi que 0,5 NO es "mitad y mitad": pesa mucho mas la frescura.
const DEFAULT_FRESHNESS_WEIGHT = 0.3;

/** Lee un peso 0-1; vacio, no numerico o fuera de rango devuelve `fallback`. */
function parseWeight(raw, fallback = DEFAULT_FRESHNESS_WEIGHT) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

const FRESHNESS_WEIGHT = parseWeight(process.env.FRESHNESS_WEIGHT);

// Meseta de la frescura (horas): una nota de hasta esta edad vale frescura 100, da igual que tenga 20 minutos o 3 horas.
// Para quien lee el digest no hay diferencia entre "recien salida" y "de esta manana"; sin meseta, 5 puntos de
// importancia alcanzaban para cambiar una nota de 4 h por una de 30 minutos (en la muestra, 1 de cada 6 elecciones
// cambiaba asi, casi todas entre notas ya frescas). Se ajusta con FRESHNESS_PLATEAU_HOURS (0 = sin meseta);
// un valor invalido, negativo o que no sea menor al tope de 24 h vuelve al valor por defecto.
const DEFAULT_FRESHNESS_PLATEAU_HOURS = 4;

/** Lee una meseta en horas, de 0 a menos que MAX_ARTICLE_AGE_HOURS; vacio, no numerico o fuera de rango devuelve `fallback`. */
function parsePlateauHours(raw, fallback = DEFAULT_FRESHNESS_PLATEAU_HOURS) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n < MAX_ARTICLE_AGE_HOURS ? n : fallback;
}

const FRESHNESS_PLATEAU_HOURS = parsePlateauHours(process.env.FRESHNESS_PLATEAU_HOURS);

/**
 * Frescura 0-100 de una nota de `ageHours` horas, CONTINUA: 100 hasta la meseta (4 h por defecto), despues baja
 * en linea recta y llega a 0 en MAX_ARTICLE_AGE_HOURS (24 h). Sin escalones: pasada la meseta, cada hora cuenta lo mismo.
 * Es la que usa el orden de entrega; FRESHNESS_CURVE (abajo) sigue siendo la del listado y la busqueda.
 * @param {number} ageHours
 * @param {number} [plateauHours]  hasta que edad la frescura vale 100 (por defecto FRESHNESS_PLATEAU_HOURS)
 */
function freshnessOfAge(ageHours, plateauHours = FRESHNESS_PLATEAU_HOURS) {
  if (!Number.isFinite(ageHours)) return 0;
  const age = Math.max(0, ageHours);
  if (age <= plateauHours) return 100;
  const fraction = 1 - (age - plateauHours) / (MAX_ARTICLE_AGE_HOURS - plateauHours);
  return Math.max(0, Math.min(1, fraction)) * 100;
}

// Curva de frescura (0-100) del LISTADO y la BUSQUEDA (articleRanking.js, searchArticlesBySimilarityAtlas.js):
// premia fuerte lo de hoy sin matar lo de anoche. No ordena lo que se entrega (ver freshnessOfAge).
const FRESHNESS_CURVE = [
  [2, 100],
  [6, 90], 
  [8,80],
  [10, 70],
  [12, 60],
  [18, 40],
  [24, 30],
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

/** Frescura 0-100 por escalones (FRESHNESS_CURVE). Sin fecha o pasada la ultima edad de la curva: 0. */
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
  DEFAULT_FRESHNESS_WEIGHT,
  FRESHNESS_WEIGHT,
  parseWeight,
  DEFAULT_FRESHNESS_PLATEAU_HOURS,
  FRESHNESS_PLATEAU_HOURS,
  parsePlateauHours,
  freshnessOfAge,
  getHoursSince,
  getFreshnessScore,
  isPreviewOrAgenda,
};
