'use strict';

/**
 * articleStore.js
 *
 * Lecturas de la colección `articles` que usa el motor de elección (solo lectura).
 * Está separado para que la lógica (officialPick.js, pickBestArticlePerTopic.js) se pruebe con un
 * "store" falso, sin Mongo. Todas las consultas llevan maxTimeMS para no colgar la generación de un digest.
 */

const Article = require('../models/Article');

const QUERY_TIMEOUT_MS = 8000;

// Tope de seguridad. En 24 h la categoría más grande ronda las 350 notas: esto nunca debería cortar.
const MAX_CANDIDATES = 1000;

// Campos livianos: alcanzan para decidir si una nota es elegible y en qué orden (sin resumen ni embedding).
const LIGHT_FIELDS = '_id url title publishedAt importanceScore category topic geoScope contentType section tags sourceName';

// Los mismos campos que proyecta la búsqueda híbrida (+ geoScope) y el embedding para comparar historias.
const FULL_FIELDS = [
  '_id', 'title', 'url', 'sourceName', 'section', 'region', 'tags', 'importanceScore', 'importanceLevel',
  'publishedAt', 'topic', 'category', 'geoScope', 'contentType', 'imageUrl', 'neutralTitle', 'neutralLead', 'neutralSummary',
  'rawSummary', 'contentSnippet', 'neutralityScore', 'politicalBiasRisk', 'curationStatus', 'embedding',
].join(' ');

/**
 * Notas publicadas desde `since` con importancia >= minImportance, en un tema oficial.
 *   { category, topic }       subtema exacto (la categoría se exige también: etiqueta y rubro coherentes)
 *   { category }              toda la categoría
 *   { category, excludeTopic } la categoría menos un subtema (rescate)
 * Devuelve documentos livianos (lean).
 */
async function listCandidates({ category, topic = null, excludeTopic = null, minImportance, since }) {
  const filter = { publishedAt: { $gte: since }, importanceScore: { $gte: minImportance } };
  if (category) filter.category = category;
  if (topic) filter.topic = topic;
  else if (excludeTopic) filter.topic = { $ne: excludeTopic };

  return Article.find(filter)
    .select(LIGHT_FIELDS)
    .sort({ publishedAt: -1, _id: 1 })
    .limit(MAX_CANDIDATES)
    .lean()
    .maxTimeMS(QUERY_TIMEOUT_MS);
}

/** Documentos completos (con embedding) para los finalistas. Map(String(_id) -> doc). */
async function loadFull(ids) {
  const out = new Map();
  const list = (ids || []).filter(Boolean);
  if (!list.length) return out;
  const docs = await Article.find({ _id: { $in: list } }).select(FULL_FIELDS).lean().maxTimeMS(QUERY_TIMEOUT_MS);
  for (const d of docs) out.set(String(d._id), d);
  return out;
}

/** Solo los embeddings. Map(String(_id) -> number[]). Las notas sin embedding no aparecen. */
async function loadEmbeddings(ids) {
  const out = new Map();
  const list = (ids || []).filter(Boolean);
  if (!list.length) return out;
  const docs = await Article.find({ _id: { $in: list } }).select('_id embedding').lean().maxTimeMS(QUERY_TIMEOUT_MS);
  for (const d of docs) {
    if (Array.isArray(d.embedding) && d.embedding.length > 0) out.set(String(d._id), d.embedding);
  }
  return out;
}

module.exports = {
  QUERY_TIMEOUT_MS,
  MAX_CANDIDATES,
  LIGHT_FIELDS,
  FULL_FIELDS,
  listCandidates,
  loadFull,
  loadEmbeddings,
};
