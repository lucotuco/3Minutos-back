'use strict';

/**
 * digestItems.js
 *
 * UN solo lugar que sabe cómo está guardado un digest.
 *
 * El digest que queda en `UserDeliveryRun.digest` tiene dos formas según por dónde se armó:
 *   - lo que devuelve buildDigestForUser:  { user, digest: { items } }   -> anidado
 *   - lo que guardan otros caminos:        { items }                     -> plano
 *
 * Varias partes del código resuelven eso a mano con `digest?.digest?.items || digest?.items`. Leer la forma
 * equivocada no explota: devuelve una lista vacía, y el que la lee cree que el digest no tenía notas. Por eso
 * conviene que la decisión viva en una función sola.
 */

/** Las notas de un digest guardado, sea cual sea la forma. Siempre un array (vacío si no hay). */
function itemsOfStoredDigest(stored) {
  if (!stored || typeof stored !== 'object') return [];
  if (Array.isArray(stored.digest?.items)) return stored.digest.items;
  if (Array.isArray(stored.items)) return stored.items;
  return [];
}

/** La nota de un digest guardado con ese articleId, o null. La comparación es por texto: en Mongo es un ObjectId. */
function findItemByArticleId(stored, articleId) {
  const wanted = String(articleId || '');
  if (!wanted) return null;
  return itemsOfStoredDigest(stored).find((item) => String(item?.articleId || '') === wanted) || null;
}

module.exports = {
  itemsOfStoredDigest,
  findItemByArticleId,
};
