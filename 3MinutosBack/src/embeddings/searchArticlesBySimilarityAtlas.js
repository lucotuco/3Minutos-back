const { openaiEmbeddings } = require('../config/openai');
const { getFreshnessScore, isPreviewOrAgenda } = require('../utils/freshness');
const { TtlCache } = require('../utils/llmJudge');
const Article = require('../models/Article');

const EMBEDDING_MODEL = 'text-embedding-3-small';
const VECTOR_INDEX_NAME = 'articles_embedding_index';
const HYBRID_INDEX_NAME = 'articles_hybrid_index';
const QUERY_EMBEDDING_TIMEOUT_MS = 8000;

async function generateQueryEmbedding(query = '') {
  const text = String(query || '').trim();
  if (!text) throw new Error('Missing query text');

  // Sin esto, una llamada colgada frena el digest hasta el timeout por defecto del SDK (10 min).
  const response = await openaiEmbeddings.embeddings.create(
    { model: EMBEDDING_MODEL, input: text },
    { timeout: QUERY_EMBEDDING_TIMEOUT_MS, maxRetries: 1 }
  );

  const vector = response.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('Invalid query embedding response');
  }

  return vector;
}

// ---------------------------------------------------------------------------
// Caché del embedding de la consulta
// ---------------------------------------------------------------------------
// El embedding de un texto no cambia (mismo modelo, mismo texto, mismo vector) y la consulta es la expansión de un tema,
// que repiten todos los usuarios que lo tienen: sin caché cada búsqueda pagaba una llamada a OpenAI (~0,2-0,4 s) por el
// mismo vector. El tope y el vencimiento son solo para acotar la memoria (500 vectores ≈ 6 MB).
const QUERY_EMBEDDING_CACHE_TTL_MS = 6 * 3600e3;
const QUERY_EMBEDDING_CACHE_MAX_ENTRIES = 500;

/**
 * @param {object} [p]
 * @param {(query:string)=>Promise<number[]>} [p.fetch]  cómo se calcula el vector (por defecto, OpenAI)
 * @returns {{ get:(query:string)=>Promise<number[]>, cache:TtlCache, inflight:Map, clear:()=>void }}
 *   get comparte la llamada en curso entre pedidos simultáneos del mismo texto y NO guarda los fallos. El vector que
 *   devuelve es el de la caché (no una copia): quien lo recibe no debe modificarlo.
 */
function createQueryEmbeddingCache({
  fetch = (query) => generateQueryEmbedding(query),
  ttlMs = QUERY_EMBEDDING_CACHE_TTL_MS,
  maxEntries = QUERY_EMBEDDING_CACHE_MAX_ENTRIES,
  now = Date.now,
} = {}) {
  const cache = new TtlCache({ maxEntries, ttlMs, now });
  const inflight = new Map();

  async function get(query) {
    const key = String(query || '').trim();
    if (!key) return fetch(query); // sin texto: falla como siempre ("Missing query text")

    const cached = cache.get(key);
    if (cached) return cached;
    if (inflight.has(key)) return inflight.get(key);

    const pending = (async () => {
      const vector = await fetch(key);
      cache.set(key, vector);
      return vector;
    })();
    inflight.set(key, pending);
    try {
      return await pending;
    } finally {
      inflight.delete(key);
    }
  }

  return { get, cache, inflight, clear: () => { cache.clear(); inflight.clear(); } };
}

const queryEmbeddings = createQueryEmbeddingCache();

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

  const queryVector = await queryEmbeddings.get(vectorQuery);

  const filter = {};
  if (category) filter.category = category;
  if (section) filter.section = section;
  if (region) filter.region = region;
  if (minDate) filter.publishedAt = { $gte: new Date(minDate) };

  const projectFields = {
    _id: 1, title: 1, url: 1, sourceName: 1, section: 1, region: 1, tags: 1,
    importanceScore: 1, importanceLevel: 1, publishedAt: 1, topic: 1, category: 1, geoScope: 1, contentType: 1,
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
    .sort((a, b) => (b.rrfScore - a.rrfScore) || compareIds(a.doc, b.doc))
    .map(item => {
      const article = item.doc;
      article.score = Math.min(item.rrfScore / MAX_RRF_SCORE, 1);
      return article;
    });

  const reranked = combinedResults.map((article) => ({
    ...article,
    finalScore: computeFinalScore(article),
  }));

  reranked.sort((a, b) => (b.finalScore - a.finalScore) || compareIds(a, b));
  return reranked.slice(0, limit);
}

// Desempate estable: con los mismos datos, la misma consulta devuelve las mismas notas en el mismo orden
// (los empates de RRF son comunes porque el puntaje depende solo de la posicion en cada lista).
function compareIds(a, b) {
  const x = String(a?._id ?? '');
  const y = String(b?._id ?? '');
  return x < y ? -1 : x > y ? 1 : 0;
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
  createQueryEmbeddingCache,
  queryEmbeddings,
  QUERY_EMBEDDING_CACHE_TTL_MS,
  QUERY_EMBEDDING_CACHE_MAX_ENTRIES,
  computeFinalScore,
};