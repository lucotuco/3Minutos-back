'use strict';

/**
 * contentTypes.js
 *
 * Los tipos de nota que distingue el clasificador (campo Article.contentType). La URL y el título dicen poco
 * sobre el género de una nota (Página 12, La Nación o Infobae no siempre ponen "/opinion/" en la ruta); en
 * cambio el modelo, que ya lee la nota para clasificarla, puede decir si es una noticia, un análisis, una
 * columna de opinión, una entrevista, una nota de color, un servicio (tutorial, "dónde ver", receta,
 * horóscopo), una previa/agenda o contenido patrocinado.
 *
 * Qué se entrega y qué no lo decide eligibility.js con EXCLUDED_CONTENT_TYPES:
 *   noticia, analisis, entrevista, color   -> se pueden entregar (no hay un orden por tipo)
 *   opinion, servicio, previa_agenda, publicidad -> no se entregan
 * Las notas guardadas antes de este campo tienen contentType '' y se tratan como noticia.
 */

const CONTENT_TYPES = Object.freeze({
  NEWS: 'noticia',
  ANALYSIS: 'analisis',
  OPINION: 'opinion',
  INTERVIEW: 'entrevista',
  COLOR: 'color',
  SERVICE: 'servicio',
  PREVIEW: 'previa_agenda',
  ADVERTISING: 'publicidad',
});

const CONTENT_TYPE_VALUES = Object.freeze(Object.values(CONTENT_TYPES));

// tipo -> motivo con el que eligibility.checkEligibility descarta la nota
const EXCLUDED_CONTENT_TYPES = Object.freeze({
  [CONTENT_TYPES.OPINION]: 'opinion',
  [CONTENT_TYPES.SERVICE]: 'servicio',
  [CONTENT_TYPES.PREVIEW]: 'previa_o_agenda',
  [CONTENT_TYPES.ADVERTISING]: 'publicidad',
});

/** El tipo si es uno de los conocidos; '' si no (lo que devuelva la IA fuera de la lista no se guarda). */
function sanitizeContentType(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return CONTENT_TYPE_VALUES.includes(normalized) ? normalized : '';
}

/** Motivo de descarte del tipo ('opinion', 'servicio', ...) o null si el tipo se puede entregar. */
function exclusionReasonOf(contentType) {
  const type = String(contentType ?? '').trim().toLowerCase();
  return Object.hasOwn(EXCLUDED_CONTENT_TYPES, type) ? EXCLUDED_CONTENT_TYPES[type] : null;
}

module.exports = {
  CONTENT_TYPES,
  CONTENT_TYPE_VALUES,
  EXCLUDED_CONTENT_TYPES,
  sanitizeContentType,
  exclusionReasonOf,
};
