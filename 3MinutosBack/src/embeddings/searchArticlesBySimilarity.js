const { openaiEmbeddings } = require('../config/openai');
const Article = require('../models/Article');

const EMBEDDING_MODEL = 'text-embedding-3-small';

function cosineSimilarity(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function generateQueryEmbedding(query = '') {
  const text = String(query || '').trim();

  if (!text) {
    throw new Error('Missing query text');
  }

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

async function searchArticlesBySimilarity(query, options = {}) {
  const { limit = 5 } = options;

  const queryEmbedding = await generateQueryEmbedding(query);

  const articles = await Article.find({
    embeddingStatus: 'done',
    embedding: { $exists: true, $ne: [] },
  })
    .select('title url section region tags importanceScore publishedAt embedding')
    .lean();

  const scored = articles.map((article) => ({
    ...article,
    similarity: cosineSimilarity(queryEmbedding, article.embedding),
  }));

  scored.sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, limit);
}

module.exports = {
  searchArticlesBySimilarity,
  generateQueryEmbedding,
  cosineSimilarity,
};