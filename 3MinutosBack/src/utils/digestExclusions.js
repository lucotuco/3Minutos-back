'use strict';

/**
 * digestExclusions.js
 *
 * Qué notas NO se pueden elegir al armar (o reponer) un digest:
 *   - lo que el usuario ya vio en las últimas 48 h (getAlreadyShownUrlsForUser.js)
 *   - las notas que se quedan en el digest cuando solo se reponen algunas (staleDigest.js)
 *
 * Cada exclusión tiene dos partes: urls (no repetir la nota) y
 * seenEmbeddings [{ id, title, lead, vector }] (no repetir la misma historia contada por otro medio; el id, el título
 * y la bajada son lo que ve el juez de sameEventJudge.js cuando el coseno no alcanza).
 */

const articleStore = require('./articleStore');
const { noteForJudge } = require('./judgeNote');

const SEPARATOR = '␟';

/** Exclusiones que salen de notas de un digest (por ejemplo, las que no se reemplazan). */
async function exclusionsFromItems(items = [], { loadEmbeddings = articleStore.loadEmbeddings } = {}) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean);

  const urls = [...new Set(list.map((i) => i.url).filter(Boolean))];
  const ids = [...new Set(list.map((i) => i.articleId).filter(Boolean).map(String))];

  const seenEmbeddings = [];
  if (ids.length > 0) {
    const vectors = await loadEmbeddings(ids);
    for (const item of list) {
      const vector = item.articleId ? vectors.get(String(item.articleId)) : null;
      if (Array.isArray(vector) && vector.length > 0) seenEmbeddings.push({ ...noteForJudge(item), vector });
    }
  }
  return { urls, seenEmbeddings };
}

/** Junta varias exclusiones en una (urls sin repetir). */
function mergeExclusions(...parts) {
  const urls = new Set();
  const seenEmbeddings = [];
  for (const part of parts) {
    for (const url of part?.urls || []) urls.add(url);
    seenEmbeddings.push(...(part?.seenEmbeddings || []));
  }
  return { urls: [...urls], seenEmbeddings };
}

/**
 * Clave del candado por usuario (buildDigestForUser). Un armado completo usa solo el usuario;
 * una reposición parcial agrega los temas y las notas que se quedan, así dos aperturas simultáneas
 * del mismo digest vencido comparten el trabajo pero no se pisan con un armado completo.
 */
function lockKeyFor(userId, { onlyTopics = null, keepItems = [] } = {}) {
  const user = String(userId);
  if (!Array.isArray(onlyTopics)) return user;
  const topics = onlyTopics.map(String).join(SEPARATOR);
  const keep = (Array.isArray(keepItems) ? keepItems : [])
    .map((i) => i?.url || '')
    .filter(Boolean)
    .sort()
    .join(SEPARATOR);
  return `${user}|parcial|${topics}|${keep}`;
}

module.exports = { exclusionsFromItems, mergeExclusions, lockKeyFor };
