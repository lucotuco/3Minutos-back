const { pickBestArticlePerTopic }    = require('../utils/pickBestArticlePerTopic');
const { generateNeutralCuration }    = require('../curation/generateNeutralCuration');
const { startTimer, timeAsync }      = require('./timing');

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
  if (words.length <= maxWords) return words.join(' ');
  return words.slice(0, maxWords).join(' ');
}

function buildFallbackCuration(article) {
  const title      = truncateWords(article.title || 'Noticia relevante del día', 12);
  const sourceText = cleanText(article.rawSummary || article.contentSnippet || article.summary || article.title || '');
  const lead       = truncateWords(sourceText || title, 24);
  const neutralSummary = truncateWords(sourceText || title, 70);

  return {
    neutralTitle:      article.neutralTitle      || title,
    neutralLead:       article.neutralLead       || lead,
    neutralSummary:    article.neutralSummary    || neutralSummary,
    neutralityScore:   Number(article.neutralityScore || 50),
    politicalBiasRisk: article.politicalBiasRisk || 'unknown',
    fallback: true,
  };
}

async function buildUserNewsDigest({
  topics          = [],
  alreadyShownUrls = [],
  perTopicLimit   = 10,
} = {}) {
  const totalTimer = startTimer('buildUserNewsDigest total', {
    topics,
    alreadyShownUrlsCount: alreadyShownUrls.length,
    perTopicLimit,
  });

  try {
    if (!Array.isArray(topics) || topics.length === 0) {
      totalTimer.end({ items: 0, reason: 'no_topics' });
      return { items: [] };
    }

    // numCandidates ya no aplica — la búsqueda es por categoría/topic exacto
    const picks = await timeAsync(
      'pickBestArticlePerTopic',
      () => pickBestArticlePerTopic(topics, { perTopicLimit, alreadyShownUrls }),
      { topics, perTopicLimit }
    );

    const items = await Promise.all(
      picks.map(async (pick) => {
        if (!pick.article) {
          return {
            topic:       pick.topic,
            articleId:   null,
            title:       null,
            neutralTitle: null,
            lead:        null,
            neutralLead: null,
            summary:     null,
            neutralSummary: null,
            originalTitle: null,
            url:         null,
            section:     null,
            region:      null,
            category:    null,
            tags:        [],
            cached:      false,
            fallback:    false,
            curationFallback: false,
            neutralityScore:  null,
            politicalBiasRisk: 'unknown',
            score:       null,
            finalScore:  null,
            usedFallback: pick.usedFallback || false,
            fallbackCategory: pick.fallbackCategory || null,
          };
        }

        let curationResult;

        try {
          curationResult = await timeAsync(
            'generateNeutralCuration from digest',
            () => generateNeutralCuration(pick.article._id),
            { topic: pick.topic, articleId: String(pick.article._id) }
          );
        } catch (error) {
          console.error('❌ Error curación neutral:', pick.article._id, error.message);
          curationResult = buildFallbackCuration(pick.article);
        }

        const neutralTitle = curationResult.neutralTitle
          || pick.article.neutralTitle
          || truncateWords(pick.article.title, 12);

        const neutralLead = curationResult.neutralLead
          || pick.article.neutralLead
          || truncateWords(pick.article.rawSummary || pick.article.contentSnippet || pick.article.title, 24);

        const neutralSummary = curationResult.neutralSummary
          || pick.article.neutralSummary
          || truncateWords(pick.article.rawSummary || pick.article.contentSnippet || pick.article.title, 70);

        return {
          topic:         pick.topic,
          articleId:     String(pick.article._id),

          title:         neutralTitle,
          summary:       neutralSummary,

          neutralTitle,
          lead:          neutralLead,
          neutralLead,
          neutralSummary,

          originalTitle: pick.article.title,
          imageUrl:      pick.article.imageUrl || null,

          url:           pick.article.url,
          section:       pick.article.section,
          region:        pick.article.region,
          category:      pick.article.category,   // ← campo nuevo
          tags:          pick.article.tags || [],

          cached:           Boolean(curationResult.cached),
          fallback:         false,
          curationFallback: Boolean(curationResult.fallback),

          neutralityScore:   curationResult.neutralityScore   ?? pick.article.neutralityScore   ?? null,
          politicalBiasRisk: curationResult.politicalBiasRisk || pick.article.politicalBiasRisk || 'unknown',

          score:      pick.article.score      ?? null,
          finalScore: pick.article.finalScore ?? null,
          rankingScore: pick.article.rankingScore ?? null,  // ← nuevo, útil para debug
          
          usedFallback:     Boolean(pick.usedFallback),
          fallbackCategory: pick.fallbackCategory || null,
        };
      })
    );

    // Filtrar items sin artículo (null items)
    const validItems = items.filter((i) => i.articleId !== null);
    const nullItems  = items.filter((i) => i.articleId === null);

    const newCurations      = validItems.filter((i) => !i.cached && !i.curationFallback).length;
    const cachedCurations   = validItems.filter((i) => i.cached).length;
    const fallbackCurations = validItems.filter((i) => i.curationFallback).length;

    if (nullItems.length > 0) {
      console.warn(
        `⚠️  ${nullItems.length} topic(s) sin artículos disponibles:`,
        nullItems.map((i) => i.topic).join(', ')
      );
    }

    totalTimer.end({
      items: validItems.length,
      skippedNullItems: nullItems.length,
      newCurations,
      cachedCurations,
      fallbackCurations,
    });

    return { items: validItems };
  } catch (error) {
    totalTimer.fail(error, { topics });
    throw error;
  }
}

module.exports = { buildUserNewsDigest };