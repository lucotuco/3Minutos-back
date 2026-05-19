const Article = require('../models/Article');
const { processArticleEmbedding } = require('../embeddings/processArticleEmbedding');
const { classifyArticleTopic }    = require('./classifyArticleTopic');

async function saveNormalizedArticle(article = {}) {
  if (!article.url) {
    return { status: 'skipped', reason: 'missing_url' };
  }

  const existingByUrl = await Article.findOne({ url: article.url }).select('_id url');

  if (existingByUrl) {
    return { status: 'skipped', reason: 'duplicate_url' };
  }

  const created = await Article.create({
    ...article,
    curationStatus:    article.curationStatus    || 'pending',
    neutralTitle:      article.neutralTitle      || '',
    neutralLead:       article.neutralLead       || '',
    neutralSummary:    article.neutralSummary    || '',
    neutralityScore:   article.neutralityScore   || 0,
    politicalBiasRisk: article.politicalBiasRisk || 'unknown',
    curationError:     '',
    curationGeneratedAt: null,
    curationModel:     '',
  });

  // Embedding (existente, no cambia)
  await processArticleEmbedding(created._id);

  // Clasificación temática fija (nuevo)
  try {
    const { category, topic } = await classifyArticleTopic(created);

    await Article.findByIdAndUpdate(created._id, {
      category,
      topic,
      topicStatus:        'done',
      topicGeneratedAt:   new Date(),
      topicModel:         'gpt-4o-mini',
      topicError:         '',
    });
  } catch (error) {
    console.error('❌ Error clasificando artículo:', created._id, error.message);

    await Article.findByIdAndUpdate(created._id, {
      topicStatus: 'error',
      topicError:  error.message || 'Unknown classification error',
    });
  }

  return {
    status:               'created',
    articleId:            created._id,
    classificationStatus: created.classificationStatus,
    curationStatus:       created.curationStatus,
  };
}

module.exports = { saveNormalizedArticle };