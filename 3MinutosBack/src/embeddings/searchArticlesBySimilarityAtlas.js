const { openai } = require('../config/openai');
const Article = require('../models/Article');

const EMBEDDING_MODEL = 'text-embedding-3-small';
const VECTOR_INDEX_NAME = 'articles_embedding_index';

async function generateQueryEmbedding(query = '') {
  const text = String(query || '').trim();

  if (!text) {
    throw new Error('Missing query text');
  }

  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });

  const vector = response.data?.[0]?.embedding;

  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('Invalid query embedding response');
  }

  return vector;
}

async function searchArticlesBySimilarityAtlas(query, options = {}) {
  const {
    limit = 5,
    numCandidates = 100,
    vectorLimit = 20,
    section,
    region,
  } = options;

  const queryVector = await generateQueryEmbedding(query);

  const filter = {};

  if (section) filter.section = section;
  if (region) filter.region = region;

  const pipeline = [
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
    {
      $project: {
        _id: 1,
        title: 1,
        url: 1,
        section: 1,
        region: 1,
        tags: 1,
        importanceScore: 1,
        importanceLevel: 1,
        publishedAt: 1,
        topic: 1,
        category: 1,
        imageUrl: 1,
        neutralTitle: 1,
        neutralLead: 1,
        neutralSummary: 1,
        rawSummary: 1,
        contentSnippet: 1,
        neutralityScore: 1,
        politicalBiasRisk: 1,
        curationStatus: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    },
  ];

  const results = await Article.aggregate(pipeline);

  const reranked = results.map((article) => ({
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
  const normalizedImportance = Number(article.importanceScore || 0) / 100;
  const freshnessScore = getFreshnessScore(article.publishedAt);

  return (
    vectorScore * 0.9 +
    normalizedImportance * 0.05 +
    freshnessScore * 0.05
  );
}

module.exports = {
  searchArticlesBySimilarityAtlas,
  generateQueryEmbedding,
  computeFinalScore,
};