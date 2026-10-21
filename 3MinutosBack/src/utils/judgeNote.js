'use strict';

/**
 * judgeNote.js
 *
 * La nota tal como la ve un juez con IA (sameEventJudge.js, topicJudge.js): { id, title, lead }, siempre texto
 * limpio y recortado. Sirve para una nota de `articles`, para un item de digest (articleId, bajada ya curada) o para
 * una entrada del historial; por eso vive aparte de los jueces (el historial y las exclusiones la usan sin cargar la IA).
 */

const { toPlainText } = require('./plainText');

const TITLE_MAX_CHARS = 200;
const LEAD_MAX_CHARS = 320;

/**
 * { id, title, lead } de una nota. Título y bajada neutrales primero (lo que el usuario vio); si la nota todavía no
 * está curada, el título original y el resumen.
 */
function noteForJudge(source = {}) {
  const id = source._id ?? source.id ?? source.articleId ?? '';
  return {
    id: id ? String(id) : '',
    title: toPlainText(source.neutralTitle || source.title || '', { maxChars: TITLE_MAX_CHARS }),
    lead: toPlainText(
      source.neutralLead || source.lead || source.rawSummary || source.contentSnippet || '',
      { maxChars: LEAD_MAX_CHARS },
    ),
  };
}

/** Una nota sin título ni bajada no tiene nada que comparar: no se le pregunta nada al juez. */
const canJudge = (note) => Boolean(note && (note.title || note.lead));

module.exports = { TITLE_MAX_CHARS, LEAD_MAX_CHARS, noteForJudge, canJudge };
