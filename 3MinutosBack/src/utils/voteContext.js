'use strict';

/**
 * voteContext.js
 *
 * Dado un usuario y una nota que votó, reconstruye POR QUÉ el motor había elegido esa nota.
 *
 * Es la pieza que hace útil al voto. El cliente manda solo la nota y el pulgar; el contexto (edad, importancia,
 * puntaje, zona, nivel, si fue rescate) sale de la corrida que el servidor ya tenía guardada, así no se confía en
 * el cliente y la app no necesita conocer el motor.
 *
 * Si la nota ya no está en ninguna corrida reciente (se refrescó el digest, la reemplazó staleDigest, o el voto
 * llegó días después), devuelve el contexto vacío con source 'sin_contexto'. El voto se guarda igual: perder el
 * contexto es peor que perder el voto, pero no es motivo para rechazarlo.
 *
 * Todo lo que toca Mongo entra por `models`, así se prueba sin base.
 */

const UserDeliveryRunModel = require('../models/UserDeliveryRun');
const ArticleModel = require('../models/Article');
const { findItemByArticleId } = require('./digestItems');

// Cuántas corridas del usuario se miran, de la más nueva a la más vieja. Un voto normal llega sobre el digest de
// hoy; este margen cubre el de ayer y los refrescos del medio sin recorrer toda la historia.
const MAX_RUNS_LOOKBACK = 5;

const EMPTY_CONTEXT = {
  articleUrl: null,
  topic: null,
  zona: null,
  nivel: null,
  edadHoras: null,
  importancia: null,
  puntaje: null,
  candidatosEvaluados: null,
  usedFallback: null,
  publishedAt: null,
  deliveryDate: null,
  contextSource: 'sin_contexto',
};

/**
 * El valor como número, o null si no hay dato. OJO: `Number(null)` y `Number('')` dan 0, así que un campo que
 * falta se guardaría como "importancia 0" o "edad 0 h" y después no se podría distinguir de un dato real. Un dato
 * que falta tiene que quedar en null.
 */
function numeroDe(valor) {
  if (valor === null || valor === undefined || valor === '' || typeof valor === 'boolean') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

/** El número que sigue a una etiqueta en el motivo del match ("imp=80 puntaje=83.6"), o null. */
function desdeMotivo(motivo, etiqueta) {
  const m = new RegExp(`${etiqueta}=(-?[0-9]+(?:\\.[0-9]+)?)`).exec(String(motivo || ''));
  return m ? Number(m[1]) : null;
}

/**
 * @param {string} userId
 * @param {string} articleId
 * @param {{models?: {UserDeliveryRun?: object, Article?: object}}} [opciones]
 * @returns {Promise<typeof EMPTY_CONTEXT>}
 */
async function findVoteContext(userId, articleId, { models = {} } = {}) {
  const UserDeliveryRun = models.UserDeliveryRun || UserDeliveryRunModel;
  const Article = models.Article || ArticleModel;

  if (!userId || !articleId) return { ...EMPTY_CONTEXT };

  let runs = [];
  try {
    runs = await UserDeliveryRun.find({ userId })
      .sort({ createdAt: -1 })
      .limit(MAX_RUNS_LOOKBACK)
      .select('digest deliveryDate createdAt')
      .lean();
  } catch {
    return { ...EMPTY_CONTEXT }; // una lectura que falla no puede impedir que se guarde el voto
  }

  let item = null;
  let run = null;
  for (const candidata of runs || []) {
    const encontrado = findItemByArticleId(candidata?.digest, articleId);
    if (encontrado) {
      item = encontrado;
      run = candidata;
      break;
    }
  }

  if (!item) return { ...EMPTY_CONTEXT };

  // La importancia no viaja en el item del digest: se lee de la nota, y si ya no está (la colección vence a los
  // 30 días) se cae al número que quedó escrito en el motivo del match.
  let importancia = desdeMotivo(item.matchReason, 'imp');
  try {
    const nota = await Article.findById(articleId).select('importanceScore').lean();
    if (nota && Number.isFinite(Number(nota.importanceScore))) importancia = Number(nota.importanceScore);
  } catch {
    /* se queda con lo del motivo */
  }

  return {
    articleUrl: item.url || null,
    topic: item.topic || null,
    zona: item.matchZone || null,
    nivel: item.tier || null,
    edadHoras: numeroDe(item.ageHoursAtPick),
    importancia: numeroDe(importancia),
    puntaje: desdeMotivo(item.matchReason, 'puntaje'),
    candidatosEvaluados: numeroDe(item.candidatesEvaluated),
    usedFallback: typeof item.usedFallback === 'boolean' ? item.usedFallback : null,
    publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
    deliveryDate: run?.deliveryDate || null,
    contextSource: 'corrida',
  };
}

module.exports = {
  MAX_RUNS_LOOKBACK,
  EMPTY_CONTEXT,
  desdeMotivo,
  findVoteContext,
};
