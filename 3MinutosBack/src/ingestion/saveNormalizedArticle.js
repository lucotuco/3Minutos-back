const Article = require('../models/Article');
const { buildEmbeddingText } = require('../embeddings/buildEmbeddingsText');
const { generateArticleEmbedding } = require('../embeddings/generateArticleEmbeddings');
const { cosineSimilarity } = require('../embeddings/searchArticlesBySimilarity');

async function saveNormalizedArticle(article = {}) {
  if (!article.url) {
    return { status: 'skipped', reason: 'missing_url' };
  }

  // =========================================================
  // FASE 1: Filtro Exacto de URL (Costo $0)
  // =========================================================
  const existingByUrl = await Article.findOne({ url: article.url }).select('_id url');
  if (existingByUrl) {
    return { status: 'skipped', reason: 'duplicate_url' };
  }

  // =========================================================
  // FASE 2: Deduplicación Semántica (Vectorial)
  // =========================================================
  article.embeddingText = buildEmbeddingText(article);
  let newVector = [];
  let embeddingModel = '';

  try {
    const result = await generateArticleEmbedding(article);
    newVector = result.vector;
    embeddingModel = result.embeddingModel;
  } catch (error) {
    console.error(`❌ Error generando vector temporal para "${article.title}":`, error.message);
    return { status: 'skipped', reason: 'embedding_failed' };
  }

  const limiteDias = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const candidates = await Article.aggregate([
    {
      $vectorSearch: {
        index: 'articles_embedding_index',
        path: 'embedding',
        queryVector: newVector,
        numCandidates: 150,
        limit: 15,
        filter: { publishedAt: { $gte: limiteDias } }
      }
    },
    {
      $project: { title: 1, embedding: 1 }
    }
  ]);

  for (const candidate of candidates) {
    const similarity = cosineSimilarity(newVector, candidate.embedding);
    if (similarity >= 0.92) {
      console.log(`⛔ [Fase 2] Duplicado semántico bloqueado (Similitud: ${(similarity * 100).toFixed(1)}%):`);
      console.log(`   ❌ Entrante: "${article.title}"`);
      console.log(`   📄 Existente: "${candidate.title}"`);
      return { status: 'skipped', reason: 'semantic_duplicate' };
    }
  }

  // =========================================================
  // FASE 3: Guardado Final en MongoDB
  // =========================================================
  const created = await Article.create({
    ...article,
    // Category, topic, and geoScope are populated by reviewArticlesWithAIBatch.js
    category: article.category || 'Sociedad',
    topic: article.topic || 'General',
    geoScope: article.geoScope || 'Global',
    topicStatus: article.topicStatus || 'pending',
    topicGeneratedAt: new Date(),
    topicModel: 'gpt-4o-mini',
    
    curationStatus: article.curationStatus || 'pending',
    biasAnalysis: article.biasAnalysis || '',
    neutralTitle: article.neutralTitle || '',
    neutralLead: article.neutralLead || '',
    neutralSummary: article.neutralSummary || '',
    neutralityScore: article.neutralityScore || 0,
    politicalBiasRisk: article.politicalBiasRisk || 'unknown',
    curationError: '',
    curationGeneratedAt: null,
    curationModel: '',
    
    embeddingText: article.embeddingText,
    embedding: newVector,
    embeddingModel,
    embeddingStatus: 'done',
    embeddingGeneratedAt: new Date(),
    embeddingError: '',
  });

  return {
    status: 'created',
    articleId: created._id,
    classificationStatus: created.classificationStatus,
    curationStatus: created.curationStatus,
  };
}

module.exports = { saveNormalizedArticle };