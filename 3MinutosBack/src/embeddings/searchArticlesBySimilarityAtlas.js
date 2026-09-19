const { openaiEmbeddings } = require('../config/openai');
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

function getFreshnessScore(publishedAt) {
  if (!publishedAt) return 0;

  const now = Date.now();
  const published = new Date(publishedAt).getTime();
  const diffHours = (now - published) / (1000 * 60 * 60);

  if (diffHours <= 6) return 1;
  if (diffHours <= 12) return 0.85;
  if (diffHours <= 24) return 0.65;
  if (diffHours <= 36) return 0.4;
  if (diffHours <= 48) return 0.2;
  if (diffHours <= 72) return 0.08;
  return 0.02;
}

function computeFinalScore(article = {}) {
  const vectorScore = Number(article.score || 0);
  let normalizedImportance = Number(article.importanceScore || 0) / 100;
  const freshnessScore = getFreshnessScore(article.publishedAt);

  const title = String(article.title || '').toLowerCase();
  const isPreviewOrAgenda = title.includes('en vivo') || 
                            title.includes('a qué hora') || 
                            title.includes('a que hora') || 
                            title.includes('dónde ver') || 
                            title.includes('donde ver') || 
                            title.includes('minuto a minuto') || 
                            title.includes('formaciones') ||
                            title.includes('agenda de partidos') ||
                            title.includes('partidos de hoy') ||
                            title.includes('qué canal') ||
                            title.includes('tabla de posiciones') ||
                            title.includes('fixture');

  if (isPreviewOrAgenda) {
    normalizedImportance = normalizedImportance * 0.1;
    return (vectorScore * 0.4 + normalizedImportance * 0.05 + freshnessScore * 0.05) * 100;
  }

  return (
    vectorScore * 0.9 +
    normalizedImportance * 0.05 +
    freshnessScore * 0.05
  ) * 100;
}

module.exports = {
  searchArticlesBySimilarityAtlas,
  generateQueryEmbedding,
  computeFinalScore,
};