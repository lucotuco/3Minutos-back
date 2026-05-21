const { z } = require('zod');
const { zodTextFormat } = require('openai/helpers/zod');
const { openai, OPENAI_MODEL } = require('../config/openai');
const { buildEmbeddingText } = require('../embeddings/buildEmbeddingsText');


const BatchReviewSchema = z.object({
  reviews: z.array(
    z.object({
      url: z.string().min(1),
      tags: z.array(z.string().min(1).max(50)).max(5),
      importanceScore: z.number().min(0).max(100),
      aiConfidence: z.number().min(0).max(1),
    })
  ),
});

function sanitizeTag(tag = '') {
  return String(tag).trim().toLowerCase().slice(0, 50);
}

function getImportanceLevel(score = 0) {
  const numericScore = Number(score || 0);

  if (numericScore >= 70) return 'high';
  if (numericScore >= 40) return 'medium';
  return 'low';
}

function buildArticlePayload(article = {}) {
  return {
    url: article.url || '',
    sourceName: article.sourceName || '',
    sourceUrl: article.sourceUrl || '',
    sourceType: article.sourceType || '',
    title: article.title || '',
    category: article.category || '',
    rawSummary: article.rawSummary || '',
    contentSnippet: article.contentSnippet || '',
    normalizedTitle: article.normalizedTitle || '',

    region: article.region || article.region || 'global',
    tags: article.tags || article.tags || [],
    tagScores: article.tagScores || article.tagScores || {},
  };
}

async function reviewArticlesWithAIBatch(articles = []) {
  if (!Array.isArray(articles) || articles.length === 0) {
    return [];
  }

  const payload = articles.map(buildArticlePayload);

  const systemPrompt = `
Sos un clasificador editorial de noticias.
Tu tarea es clasisficar las noticias que te voy a pasar, categoria, tags e importanceScore.

Reglas:
- Devolvé exactamente una review por cada artículo recibido.
- Usá el campo "url" para identificar cada resultado.
- Tags debe tener entre 0 y 5 tags, cortos y útiles.
- No inventes hechos.
- importanceScore va de 0 a 100 en base a la importancia del artículo.
- aiConfidence va de 0 a 1.
- Priorizá el tema central de la noticia, no menciones secundarias.
`;

  const userPrompt = `
Revisá estos artículos y devolvé el resultado final para cada uno.

Artículos:
${JSON.stringify(payload, null, 2)}
`;

  const response = await openai.responses.parse({
    model: OPENAI_MODEL,
    store: false,
    input: [
      { role: 'system', content: systemPrompt.trim() },
      { role: 'user', content: userPrompt.trim() },
    ],
    text: {
      format: zodTextFormat(BatchReviewSchema, 'article_batch_review'),
    },
  });

  const parsed = response.output_parsed;
  const reviewMap = new Map();

  for (const item of parsed.reviews || []) {
    const tags = Array.from(
      new Set((item.tags || []).map(sanitizeTag).filter(Boolean))
    ).slice(0, 5);

    const tagScores = tags.reduce((acc, tag) => {
      acc[tag] = Number(item.aiConfidence || 0);
      return acc;
    }, {});

    reviewMap.set(item.url, {
      section: item.section,
      region: item.region,
      tags,
      tagScores,
      importanceScore: Number(item.importanceScore),
      importanceLevel: getImportanceLevel(item.importanceScore),
      aiConfidence: Number(item.aiConfidence),
      aiReviewed: true,
      classificationStatus: item.aiChangedClassification ? 'ai_corrected' : 'ai_reviewed',
    });
  }

  return articles.map((article) => {
    const review = reviewMap.get(article.url);

    if (!review) {
      return {
        ...article,
        aiReviewed: false,
        aiConfidence: 0,
        aiChangedClassification: false,
        aiReason: 'AI batch review returned no result for this article',
        classificationStatus: 'needs_review',
        importanceLevel: getImportanceLevel(article.importanceScore || 0),
      };
    }

    const enrichedArticle = {
  ...article,
  section: review.section,
  region: review.region,
  tags: review.tags,
  tagScores: review.tagScores,
  importanceScore: review.importanceScore,
  importanceLevel: review.importanceLevel,
  aiConfidence: review.aiConfidence,
  classificationStatus: review.classificationStatus,
};

return {
  ...enrichedArticle,
  embeddingText: buildEmbeddingText(enrichedArticle),
  embeddingStatus: 'pending',
  embeddingModel: '',
  embeddingGeneratedAt: null,
  embeddingError: '',
};
  });
}

module.exports = {
  reviewArticlesWithAIBatch,
};