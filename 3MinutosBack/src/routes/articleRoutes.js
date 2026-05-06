const express = require('express');

const Article = require('../models/Article');
const { getTopArticles } = require('../utils/getTopArticles');

const router = express.Router();

function cleanString(value, maxLength = 80) {
  if (value === undefined || value === null || value === '') return null;

  const clean = String(value).trim();

  if (!clean || clean.length > maxLength) return null;

  return clean;
}

function parseLimit(value, defaultValue, maxValue) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }

  return Math.min(Math.floor(parsed), maxValue);
}

function buildArticleFilters(query) {
  const filters = {};
  const andFilters = [];

  const section = cleanString(query.section);
  const region = cleanString(query.region);
  const tag = cleanString(query.tag);
  const sourceName = cleanString(query.sourceName);
  const country = cleanString(query.country);
  const category = cleanString(query.category);

  if (section) {
    andFilters.push({
      $or: [{ section }, { Section: section }],
    });
  }

  if (region) {
    andFilters.push({
      $or: [{ region }, { Region: region }],
    });
  }

  if (tag) {
    andFilters.push({
      $or: [{ tags: tag }, { Tags: tag }],
    });
  }

  if (sourceName) filters.sourceName = sourceName;
  if (country) filters.country = country;

  if (!section && category) {
    filters.category = category;
  }

  if (andFilters.length > 0) {
    filters.$and = andFilters;
  }

  return {
    filters,
    normalized: {
      section,
      region,
      tag,
      sourceName,
      country,
      category: !section ? category : null,
    },
  };
}

router.get('/', async (req, res) => {
  try {
    const { filters, normalized } = buildArticleFilters(req.query);
    const parsedLimit = parseLimit(req.query.limit, 50, 100);

    const articles = await Article.find(filters)
      .sort({
        publishedAt: -1,
        createdAt: -1,
      })
      .limit(parsedLimit)
      .select(
        [
          'title',
          'sourceName',
          'category',
          'section',
          'Section',
          'region',
          'Region',
          'publishedAt',
          'url',
          'tags',
          'Tags',
          'TagScores',
          'rawSummary',
          'importanceScore',
          'importanceLevel',
        ].join(' ')
      )
      .lean();

    return res.json({
      total: articles.length,
      filters: {
        ...normalized,
        limit: parsedLimit,
      },
      articles,
    });
  } catch (error) {
    console.error('[GET /articles]', error);

    return res.status(500).json({
      error: 'Error al obtener artículos',
      code: 'FETCH_ARTICLES_FAILED',
    });
  }
});

router.get('/top', async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, 5, 20);
    const candidateLimit = parseLimit(req.query.candidateLimit, 200, 500);

    const filters = {
      tag: cleanString(req.query.tag),
      region: cleanString(req.query.region),
      section: cleanString(req.query.section),
      category: cleanString(req.query.category),
      sourceName: cleanString(req.query.sourceName),
      fromDate: cleanString(req.query.fromDate, 30),
      toDate: cleanString(req.query.toDate, 30),
    };

    const articles = await getTopArticles(filters, {
      limit,
      candidateLimit,
    });

    return res.json({
      ok: true,
      count: articles.length,
      filters,
      items: articles,
    });
  } catch (error) {
    console.error('[GET /articles/top]', error);

    return res.status(500).json({
      ok: false,
      error: 'Error getting top articles',
      code: 'FETCH_TOP_ARTICLES_FAILED',
    });
  }
});

module.exports = router;