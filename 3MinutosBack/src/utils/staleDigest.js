'use strict';

/**
 * staleDigest.js
 *
 * Revisión del digest GUARDADO cuando el usuario lo abre.
 *
 * Un digest se prepara antes (el cron lo arma ~15 minutos antes de la hora de entrega) y el usuario
 * lo abre mucho después. La app no muestra la edad de las notas, así que una nota vieja parece nueva:
 * el tope de 24 h tiene que cumplirse cuando el usuario la VE, no cuando se armó el digest.
 *
 * Al abrirlo:
 *   1. se mide la edad de cada nota contra "ahora"
 *   2. las vencidas (o sin fecha creíble) se reemplazan por otra nota elegible del MISMO tema; el motor
 *      sabe cuáles se quedan en el digest, así que no las repite ni trae su misma historia
 *   3. si no hay reemplazo, la nota se saca: mejor un hueco que una nota vieja
 *   4. lo reemplazado se guarda en el mismo run, sin tocar preparedAt (el enfriamiento del refresco no cambia)
 *
 * La revisión nunca puede romper la apertura: si falla algo inesperado se sirve el digest como estaba.
 * Si falla solo el reemplazo, se sirve el digest SIN las vencidas y no se guarda (la próxima apertura reintenta).
 *
 * El acceso a Mongo y al motor llega por `rebuild` y `persist`, así todo esto se prueba sin base de datos.
 */

const { MAX_ARTICLE_AGE_HOURS } = require('./freshness');
const { ageHoursOf, MAX_FUTURE_SKEW_HOURS, normalizeText } = require('./eligibility');

const AUDIO_KEYS = ['audioUrl', 'audioStorageKey', 'audioGeneratedAt'];

/**
 * Las notas de un digest guardado. Hay dos formas: { user, digest: { items } } (la actual) e { items } (la vieja).
 * @returns {{items: object[], shape: 'nested'|'root'|null}}
 */
function digestItemsOf(stored) {
  if (Array.isArray(stored?.digest?.items)) return { items: stored.digest.items, shape: 'nested' };
  if (Array.isArray(stored?.items)) return { items: stored.items, shape: 'root' };
  return { items: [], shape: null };
}

/** null si la nota sirve; si no, el motivo: 'sin_fecha' | 'vencida' | 'fecha_futura'. */
function staleReason(item, now = Date.now()) {
  const age = ageHoursOf(item, now);
  if (age === null) return 'sin_fecha';
  if (age > MAX_ARTICLE_AGE_HOURS) return 'vencida';
  if (age < -MAX_FUTURE_SKEW_HOURS) return 'fecha_futura';
  return null;
}

/** Separa las notas que sirven de las vencidas, conservando la posición original de cada una. */
function splitByFreshness(items, now = Date.now()) {
  const fresh = [];
  const stale = [];
  (Array.isArray(items) ? items : []).forEach((item, index) => {
    const reason = staleReason(item, now);
    if (reason) stale.push({ item, index, reason });
    else fresh.push({ item, index });
  });
  return { fresh, stale };
}

/**
 * Arma la lista final: cada nota vencida se cambia, en su lugar, por una reposición del mismo tema
 * (una reposición se usa una sola vez); si no hay, la nota se saca.
 */
function mergeReplacements(items, staleIndexes, replacements) {
  const stale = new Set(staleIndexes);
  const pool = (replacements || []).map((item) => ({ item, used: false }));
  const out = [];
  let replaced = 0;
  let dropped = 0;

  items.forEach((item, i) => {
    if (!stale.has(i)) {
      out.push(item);
      return;
    }
    const key = normalizeText(item?.topic);
    const match = key ? pool.find((p) => !p.used && normalizeText(p.item?.topic) === key) : null;
    if (match) {
      match.used = true;
      out.push(match.item);
      replaced++;
    } else {
      dropped++;
    }
  });

  return { items: out, replaced, dropped };
}

function clearAudio(obj) {
  const copy = { ...obj };
  for (const key of AUDIO_KEYS) if (key in copy) copy[key] = null;
  return copy;
}

/** Copia del digest guardado con otra lista de notas (y sin el audio del digest entero, que ya no corresponde). */
function withItems(stored, shape, items) {
  if (shape === 'nested') return { ...stored, digest: { ...clearAudio(stored.digest), items } };
  return { ...clearAudio(stored), items };
}

/**
 * Revisa un digest guardado y reemplaza lo vencido.
 *
 * @param {object} stored  el digest tal como se guardó
 * @param {object} p
 * @param {number} [p.now]
 * @param {(opts:{onlyTopics:string[], keepItems:object[]})=>Promise<object>} p.rebuild  arma reposiciones solo para esos temas
 * @returns {Promise<{digest:object, changed:boolean, staleCount:number, replaced:number, dropped:number, failed:Error|null, reasons:string[]}>}
 */
async function refreshStaleItems(stored, { now = Date.now(), rebuild } = {}) {
  const { items, shape } = digestItemsOf(stored);
  const { fresh, stale } = splitByFreshness(items, now);
  const result = {
    digest: stored, changed: false, staleCount: stale.length, replaced: 0, dropped: 0, failed: null,
    reasons: stale.map((s) => s.reason),
  };
  if (!shape || stale.length === 0) return result;

  // Un tema por cada nota vencida (con repetidos: si el digest tenía dos notas del mismo tema, se piden dos).
  const topics = stale
    .map((s) => (typeof s.item?.topic === 'string' ? s.item.topic.trim() : ''))
    .filter(Boolean);

  let replacements = [];
  if (topics.length > 0 && typeof rebuild === 'function') {
    try {
      const rebuilt = await rebuild({ onlyTopics: topics, keepItems: fresh.map((f) => f.item) });
      replacements = digestItemsOf(rebuilt).items;
    } catch (error) {
      result.failed = error;
    }
  }

  // Defensa: una reposición que tampoco está vigente no sirve (el motor ya lo garantiza; esto es el cinturón).
  const usable = replacements.filter((r) => r && staleReason(r, now) === null);
  const merged = mergeReplacements(items, stale.map((s) => s.index), usable);

  result.digest = withItems(stored, shape, merged.items);
  result.changed = true;
  result.replaced = merged.replaced;
  result.dropped = merged.dropped;
  return result;
}

/**
 * Lo que usan las rutas: revisa el digest de un run, reemplaza lo vencido y lo guarda.
 *
 * @param {object} run  el UserDeliveryRun (lean) con `digest`
 * @param {object} p
 * @param {number} [p.now]
 * @param {Function} p.rebuild  ver refreshStaleItems
 * @param {(run:object, digest:object)=>Promise<void>} [p.persist]  guarda el digest ya revisado (no se llama si falló el reemplazo)
 * @param {{log:Function, error:Function}} [p.logger]
 * @returns {Promise<{digest:object, changed:boolean, staleCount:number, replaced:number, dropped:number, failed:Error|null, error?:Error}>}
 */
async function ensureFreshDigest(run, { now = Date.now(), rebuild, persist, logger = console } = {}) {
  let stored;
  try {
    stored = run?.digest;
    const r = await refreshStaleItems(stored, { now, rebuild });
    if (!r.changed) return r;

    logger.log(
      `[Digest vencido] run=${String(run?._id)} vencidas=${r.staleCount} (${r.reasons.join(',')}) ` +
      `reemplazadas=${r.replaced} quitadas=${r.dropped}` +
      (r.failed ? ` | falló el reemplazo: ${r.failed.message}` : '')
    );

    if (!r.failed && typeof persist === 'function') {
      try {
        await persist(run, r.digest);
      } catch (error) {
        logger.error(`[Digest vencido] no se pudo guardar el digest revisado (run=${String(run?._id)}):`, error);
      }
    }
    return r;
  } catch (error) {
    logger.error('[Digest vencido] la revisión falló; se sirve el digest como estaba:', error);
    return {
      digest: stored, changed: false, staleCount: 0, replaced: 0, dropped: 0, failed: null, reasons: [], error,
    };
  }
}

module.exports = {
  digestItemsOf,
  staleReason,
  splitByFreshness,
  mergeReplacements,
  withItems,
  refreshStaleItems,
  ensureFreshDigest,
};
