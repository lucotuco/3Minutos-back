const { openaiEmbeddings } = require('../config/openai');
const { getFreshnessScore, isPreviewOrAgenda } = require('../utils/freshness');
const Article = require('../models/Article');

const EMBEDDING_MODEL = 'text-embedding-3-small';
const VECTOR_INDEX_NAME = 'articles_embedding_index';
const HYBRID_INDEX_NAME = 'articles_hybrid_index';

async function generateQueryEmbedding(query = '') {
  const text = String(query || '').trim();
  if (!text) throw new Error('Missing query text');

  const response = await openaiEmbeddings.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });

  const vector = response.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('Invalid query embedding response');
  }

  return vector;
}

// 💥 NUEVO: Ahora recibimos la consulta exacta (texto) y la expandida (vector)
async function searchArticlesBySimilarityAtlas(exactQuery, vectorQuery, options = {}) {
  const {
    limit = 20,
    numCandidates = 200,
    vectorLimit = 50,
    section,
    region,
    minDate,
    category
  } = options;

  const queryVector = await generateQueryEmbedding(vectorQuery);

  const filter = {};
  if (category) filter.category = category;
  if (section) filter.section = section;
  if (region) filter.region = region;
  if (minDate) filter.publishedAt = { $gte: new Date(minDate) };

  const projectFields = {
    _id: 1, title: 1, url: 1, sourceName: 1, section: 1, region: 1, tags: 1,
    importanceScore: 1, importanceLevel: 1, publishedAt: 1, topic: 1, category: 1,
    imageUrl: 1, neutralTitle: 1, neutralLead: 1, neutralSummary: 1, rawSummary: 1,
    contentSnippet: 1, neutralityScore: 1, politicalBiasRisk: 1, curationStatus: 1,
  };

  // ---------------------------------------------------------
  // 1. MOTOR VECTORIAL (Conceptos y Semántica)
  // ---------------------------------------------------------
  const vectorPipeline = [
    {
      $vectorSearch: {
        index: VECTOR_INDEX_NAME,
        path: 'embedding',
        queryVector,
        numCandidates,
        limit: vectorLimit,
        ...(Object.keys(filter).length ? { filter } : {}),
      },
    },
    { $project: { ...projectFields, vectorScore: { $meta: 'vectorSearchScore' } } }
  ];

  // ---------------------------------------------------------
  // 2. MOTOR LÉXICO (Coincidencia Exacta de Texto BM25)
  // ---------------------------------------------------------
  const textPipeline = [
    {
      $search: {
        index: HYBRID_INDEX_NAME,
        text: {
          query: exactQuery,
          path: ["title", "tags", "rawSummary"]
        }
      }
    },
    { $match: filter },
    { $limit: vectorLimit },
    { $project: { ...projectFields, textScore: { $meta: 'searchScore' } } }
  ];

  // Disparamos ambos motores AL MISMO TIEMPO
  const [vectorResults, textResults] = await Promise.all([
    Article.aggregate(vectorPipeline),
    Article.aggregate(textPipeline)
  ]);

  // ---------------------------------------------------------
  // 3. FUSIÓN MATEMÁTICA RRF (Reciprocal Rank Fusion)
  // ---------------------------------------------------------
  const rrfMap = new Map();
  const K = 60; // Constante universal para RRF

  // Puntuar ganadores del Vector
  vectorResults.forEach((doc, index) => {
    const rank = index + 1;
    const rrfScore = 1 / (K + rank);
    rrfMap.set(String(doc._id), { doc, rrfScore });
  });

  // Puntuar ganadores del Texto y sumarlo si coinciden
  textResults.forEach((doc, index) => {
    const rank = index + 1;
    const rrfScore = 1 / (K + rank);
    const idStr = String(doc._id);
    if (rrfMap.has(idStr)) {
      rrfMap.get(idStr).rrfScore += rrfScore; // ¡Jackpot! Apareció en ambos.
    } else {
      rrfMap.set(idStr, { doc, rrfScore });
    }
  });

  // ---------------------------------------------------------
  // 4. NORMALIZACIÓN Y RERANKING
  // ---------------------------------------------------------
  // El score máximo posible en RRF con K=60 es ~0.03278 (Puesto 1 en ambos)
  // Lo normalizamos de 0 a 1 para que encaje con tu lógica actual de 0.77
  const MAX_RRF_SCORE = (1 / 61) + (1 / 61);

  const combinedResults = Array.from(rrfMap.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(item => {
      const article = item.doc;
      article.score = Math.min(item.rrfScore / MAX_RRF_SCORE, 1);
      return article;
    });

  const reranked = combinedResults.map((article) => ({
    ...article,
    finalScore: computeFinalScore(article),
  }));

  reranked.sort((a, b) => b.finalScore - a.finalScore);
  return reranked.slice(0, limit);
}

// Pesos del puntaje final (suman 1). La relevancia ya se controla aparte con las zonas
// (score >= 0.80), el ancla lexica y el corral de categoria, que usan article.score,
// no finalScore. Por eso la frescura puede pesar fuerte en el orden de los candidatos validos.
const FINAL_WEIGHTS = { similarity: 0.55, importance: 0.05, freshness: 0.40 };
const PREVIEW_PENALTY = 0.5; // previas/agenda/en vivo valen la mitad

function computeFinalScore(article = {}) {
  const similarity = Number(article.score || 0);
  const importance = Number(article.importanceScore || 0) / 100;
  const freshness = getFreshnessScore(article.publishedAt) / 100;

  const base =
    similarity * FINAL_WEIGHTS.similarity +
    importance * FINAL_WEIGHTS.importance +
    freshness * FINAL_WEIGHTS.freshness;

  return (isPreviewOrAgenda(article.title) ? base * PREVIEW_PENALTY : base) * 100;
}

module.exports = {
  searchArticlesBySimilarityAtlas,
  generateQueryEmbedding,
  computeFinalScore,
};