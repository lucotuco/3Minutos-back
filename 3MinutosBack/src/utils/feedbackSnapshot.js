'use strict';

/**
 * feedbackSnapshot.js
 *
 * Lo que la encuesta semanal guarda de "qué estaba mirando el usuario": las notas del digest de su corrida más
 * reciente, cada una con la decisión del motor. Es una función pura (la corrida entra ya leída) para probarla sin Mongo.
 */

const { itemsOfStoredDigest } = require('./digestItems');

const numOrNull = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/** La validación del cuerpo de la encuesta. Devuelve { ok, rating, comment } o { ok:false, code, error }. */
function parseFeedbackBody(body = {}, { ratings = [1, 2, 3], commentMax = 500 } = {}) {
  const rating = Number(body?.rating);
  if (!ratings.includes(rating)) {
    return { ok: false, code: 'INVALID_RATING', error: `rating must be one of: ${ratings.join(', ')}` };
  }

  const raw = body?.comment;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    return { ok: false, code: 'INVALID_COMMENT', error: 'comment must be a string' };
  }
  const comment = String(raw || '').replace(/\s+/g, ' ').trim();
  if (comment.length > commentMax) {
    return { ok: false, code: 'COMMENT_TOO_LONG', error: `comment must be at most ${commentMax} characters` };
  }

  return { ok: true, rating, comment };
}

/** Las notas del digest de una corrida, resumidas para la encuesta. Sin corrida: lista vacía. */
function snapshotFromRun(run) {
  const notas = itemsOfStoredDigest(run?.digest).map((item) => ({
    // Solo un id de Mongo válido: cualquier otra cosa haría fallar el guardado de toda la respuesta.
    articleId: /^[a-f0-9]{24}$/i.test(String(item?.articleId || '')) ? String(item.articleId) : null,
    topic: item?.topic || null,
    zona: item?.matchZone || null,
    nivel: item?.tier || null,
    edadHoras: numOrNull(item?.ageHoursAtPick),
    usedFallback: typeof item?.usedFallback === 'boolean' ? item.usedFallback : null,
  }));

  return {
    deliveryDate: run?.deliveryDate || null,
    notas,
  };
}

module.exports = { parseFeedbackBody, snapshotFromRun };
