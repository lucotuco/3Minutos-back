const { openaiEmbeddings } = require('../config/openai');

const EMBEDDING_MODEL = 'text-embedding-3-small';

async function generateArticleEmbedding(article = {}) {
  const embeddingText = String(article.embeddingText || '').trim();

  if (!embeddingText) {
    throw new Error('Missing embeddingText');
  }

  const response = await openaiEmbeddings.embeddings.create({
    model: EMBEDDING_MODEL,
    input: embeddingText,
  });

  const vector = response.data?.[0]?.embedding;

  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('Invalid embedding response');
  }

  return {
    vector,
    embeddingModel: EMBEDDING_MODEL,
    embeddingText,
  };
}

module.exports = {
  generateArticleEmbedding,
  EMBEDDING_MODEL,
};