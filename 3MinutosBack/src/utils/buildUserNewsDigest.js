const { pickBestArticlePerTopic } = require('../utils/pickBestArticlePerTopic');
const { generateNeutralCuration } = require('../curation/generateNeutralCuration');
const { startTimer, timeAsync } = require('./timing');

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
  const totalTimer = startTimer('buildUserNewsDigest total', {
    topics,
    alreadyShownUrlsCount: alreadyShownUrls.length,
    perTopicLimit,
    numCandidates,
  });

  try {
    if (!Array.isArray(topics) || topics.length === 0) {
      totalTimer.end({
        items: 0,
        reason: 'no_topics',
      });

      return {
        items: [],
      };
    }

    const picks = await timeAsync(
      'pickBestArticlePerTopic',
      () =>
        pickBestArticlePerTopic(topics, {
          perTopicLimit,
          numCandidates,
          alreadyShownUrls,
        }),
      {
        topics,
        perTopicLimit,
        numCandidates,
      }
    );

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
          console.log('🧠 Preparando curación para digest', {
            topic: pick.topic,
            articleId: String(pick.article._id),
            title: pick.article.title,
            curationStatus: pick.article.curationStatus,
            hasNeutralTitle: Boolean(pick.article.neutralTitle),
          });

          curationResult = await timeAsync(
            'generateNeutralCuration from digest',
            () => generateNeutralCuration(pick.article._id),
            {
              topic: pick.topic,
              articleId: String(pick.article._id),
              title: pick.article.title,
            }
          );
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

          title: neutralTitle,
          summary: neutralSummary,

          neutralTitle,
          lead: neutralLead,
          neutralLead,
          neutralSummary,

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

    const newCurations = items.filter(
      (item) => item.articleId && !item.cached && !item.curationFallback
    ).length;
    const cachedCurations = items.filter((item) => item.cached).length;
    const fallbackCurations = items.filter((item) => item.curationFallback).length;

    totalTimer.end({
      items: items.length,
      newCurations,
      cachedCurations,
      fallbackCurations,
    });

    return {
      items,
    };
  } catch (error) {
    totalTimer.fail(error, {
      topics,
    });

    throw error;
  }
}

module.exports = {
  buildUserNewsDigest,
};