const Article = require('../models/Article');
const { processArticleEmbedding } = require('../embeddings/processArticleEmbedding');

async function saveNormalizedArticle(article = {}) {
  if (!article.url) {
    return {
      status: 'skipped',
      reason: 'missing_url',
    };
  }

  const existingByUrl = await Article.findOne({ url: article.url }).select('_id url');

  if (existingByUrl) {
    return {
      status: 'skipped',
      reason: 'duplicate_url',
    };
  }

  const created = await Article.create({
    ...article,

    // Capa editorial neutral. Se genera luego, cuando el artículo entra en un digest.
    curationStatus: article.curationStatus || 'pending',
    neutralTitle: article.neutralTitle || '',
    neutralLead: article.neutralLead || '',
    neutralSummary: article.neutralSummary || '',
    neutralityScore: article.neutralityScore || 0,
    politicalBiasRisk: article.politicalBiasRisk || 'unknown',
    curationError: '',
    curationGeneratedAt: null,
    curationModel: '',
  });

  await processArticleEmbedding(created._id);

  return {
    status: 'created',
    articleId: created._id,
    aiReviewed: created.aiReviewed,
    classificationStatus: created.classificationStatus,
    curationStatus: created.curationStatus,
  };
}

module.exports = {
  saveNormalizedArticle,
};