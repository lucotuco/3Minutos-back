const { pickBestArticlePerTopic } = require('../utils/pickBestArticlePerTopic');
const { generateNeutralCuration } = require('../curation/generateNeutralCuration');

function cleanText(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateWords(text, maxWords) {
  const words = cleanText(text).split(/\s+/).filter(Boolean);

  if (words.length <= maxWords) {
    return words.join(' ');
  }

  return words.slice(0, maxWords).join(' ');
}

function buildFallbackCuration(article) {
  const title = truncateWords(article.title || 'Noticia relevante del día', 12);

  const sourceText = cleanText(
    article.rawSummary ||
      article.contentSnippet ||
      article.summary ||
      article.title ||
      ''
  );

  const lead = truncateWords(sourceText || title, 24);
  const neutralSummary = truncateWords(sourceText || title, 70);

  return {
    neutralTitle: article.neutralTitle || title,
    neutralLead: article.neutralLead || lead,
    neutralSummary: article.neutralSummary || neutralSummary,
    neutralityScore: Number(article.neutralityScore || 50),
    politicalBiasRisk: article.politicalBiasRisk || 'unknown',
    fallback: true,
  };
}

async function buildUserNewsDigest({
  topics = [],
  alreadyShownUrls = [],
  perTopicLimit = 10,
  numCandidates = 100,
} = {}) {
  if (!Array.isArray(topics) || topics.length === 0) {
    return {
      items: [],
    };
  }

  const picks = await pickBestArticlePerTopic(topics, {
    perTopicLimit,
    numCandidates,
    alreadyShownUrls,
  });

  const items = await Promise.all(
    picks.map(async (pick) => {
      if (!pick.article) {
        return {
          topic: pick.topic,
          articleId: null,

          title: null,
          neutralTitle: null,

          lead: null,
          neutralLead: null,

          summary: null,
          neutralSummary: null,

          originalTitle: null,

          url: null,
          section: null,
          region: null,
          tags: [],

          cached: false,
          fallback: false,
          curationFallback: false,

          neutralityScore: null,
          politicalBiasRisk: 'unknown',

          score: null,
          finalScore: null,
        };
      }

      let curationResult;

      try {
        curationResult = await generateNeutralCuration(pick.article._id);
      } catch (error) {
        console.error('❌ Error usando curación neutral en digest');
        console.error('articleId:', String(pick.article._id));
        console.error('title:', pick.article.title);
        console.error('error:', error.message);

        curationResult = buildFallbackCuration(pick.article);
      }

      const neutralTitle =
        curationResult.neutralTitle ||
        pick.article.neutralTitle ||
        truncateWords(pick.article.title, 12);

      const neutralLead =
        curationResult.neutralLead ||
        pick.article.neutralLead ||
        truncateWords(
          pick.article.rawSummary || pick.article.contentSnippet || pick.article.title,
          24
        );

      const neutralSummary =
        curationResult.neutralSummary ||
        pick.article.neutralSummary ||
        truncateWords(
          pick.article.rawSummary || pick.article.contentSnippet || pick.article.title,
          70
        );

      return {
        topic: pick.topic,
        articleId: String(pick.article._id),

        // Compatibilidad con el front actual.
        title: neutralTitle,
        summary: neutralSummary,

        // Campos nuevos explícitos.
        neutralTitle,
        lead: neutralLead,
        neutralLead,
        neutralSummary,

        // Solo para auditoría/debug. No mostrar como principal.
        originalTitle: pick.article.title,

        url: pick.article.url,
        section: pick.article.section,
        region: pick.article.region,
        tags: pick.article.tags || [],

        cached: Boolean(curationResult.cached),
        fallback: false,
        curationFallback: Boolean(curationResult.fallback),

        neutralityScore:
          curationResult.neutralityScore ??
          pick.article.neutralityScore ??
          null,

        politicalBiasRisk:
          curationResult.politicalBiasRisk ||
          pick.article.politicalBiasRisk ||
          'unknown',

        score: pick.article.score ?? null,
        finalScore: pick.article.finalScore ?? null,
      };
    })
  );

  return {
    items,
  };
}

module.exports = {
  buildUserNewsDigest,
};