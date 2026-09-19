const fs = require('fs');
const path = require('path');
const Parser = require('rss-parser');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

const Article = require('../models/Article');
const { adaptRssArticle } = require('./adapter/rssAdapter');
const { processArticle } = require('./processArticle');
const { saveNormalizedArticle } = require('./saveNormalizedArticle');
const { reviewArticlesWithAIBatch } = require('./reviewArticlesWithAIBatch');
const { generateArticleEmbedding } = require('../embeddings/generateArticleEmbeddings');
const { buildEmbeddingText } = require('../embeddings/buildEmbeddingsText');

const PostlightParser = require('@postlight/parser');

dotenv.config();

const FALLBACK_IMAGE_URL = 'https://st2.depositphotos.com/1036149/5381/i/950/depositphotos_53811511-stock-illustration-duck-with-sunglasses.jpg';

const parser = new Parser({
  timeout: 30000,
  customFields: {
    item: [
      ['media:content', 'media:content'],
      ['media:thumbnail', 'media:thumbnail'],
      ['image:image', 'image:image'],
      ['content:encoded', 'content:encoded'],
      ['enclosure', 'reformaEnclosure']
    ]
  }
});
const AI_BATCH_SIZE = Number(process.env.AI_BATCH_SIZE || 10);
const COSINE_SIMILARITY_THRESHOLD = 0.92;
const ATLAS_SCORE_THRESHOLD = (1 + COSINE_SIMILARITY_THRESHOLD) / 2;

function loadSources() {
  const filePath = path.join(__dirname, '..', 'Sources.json');
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

async function connectDB() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Mongo conectado a:', mongoose.connection.name);
}

function splitIntoChunks(items = [], chunkSize = 10) {
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

async function saveArticles(articles = []) {
  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const article of articles) {
    try {
      const result = await saveNormalizedArticle(article);
      if (result.status === 'created') created++;
      else skipped++;
    } catch (error) {
      errors++;
      console.log(`Error guardando articulo -> ${error.message}`);
    }
  }

  return { created, skipped, errors };
}

async function filterExistingArticles(articles = []) {
  if (!Array.isArray(articles) || articles.length === 0) {
    return {
      newArticles: [],
      duplicateArticles: [],
    };
  }

  const uniqueArticlesMap = new Map();
  const urls = [];
  const titles = [];

  for (const article of articles) {
    if (!article?.url) continue;

    if (!uniqueArticlesMap.has(article.url)) {
      uniqueArticlesMap.set(article.url, article);
      urls.push(article.url);
      if (article.title) titles.push(article.title.trim());
    }
  }

  const limiteDias = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

  const existingArticles = await Article.find({
    $or: [
      { url: { $in: urls } },
      { 
        title: { $in: titles }, 
        createdAt: { $gte: limiteDias } 
      }
    ]
  }).select('url title');

  const existingUrls = new Set(existingArticles.map((article) => article.url));
  const existingTitles = new Set(existingArticles.map((article) => article.title?.trim()));

  const newArticles = [];
  const duplicateArticles = [];

  for (const article of uniqueArticlesMap.values()) {
    const titleTrimmed = article.title?.trim();

    if (existingUrls.has(article.url) || (titleTrimmed && existingTitles.has(titleTrimmed))) {
      duplicateArticles.push(article);
    } else {
      newArticles.push(article);
    }
  }

  return {
    newArticles,
    duplicateArticles,
  };
}

async function filterVectorDuplicates(articles = []) {
  const uniqueArticles = [];
  let vectorSkipped = 0;
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  for (const article of articles) {
    try {
      const embeddingText = buildEmbeddingText(article);
      article.embeddingText = embeddingText;

      const { vector, embeddingModel } = await generateArticleEmbedding(article);

      const vectorResults = await Article.aggregate([
        {
          $vectorSearch: {
            index: 'articles_embedding_index',
            path: 'embedding',
            queryVector: vector,
            numCandidates: 50,
            limit: 1,
            filter: {
              publishedAt: { $gte: twentyFourHoursAgo }
            }
          }
        },
        {
          $project: {
            _id: 1,
            title: 1,
            score: { $meta: 'vectorSearchScore' }
          }
        }
      ]);

      if (vectorResults.length > 0 && vectorResults[0].score >= ATLAS_SCORE_THRESHOLD) {
        console.log(`Duplicado vectorial detectado (score: ${vectorResults[0].score.toFixed(4)}): ${article.title}`);
        vectorSkipped++;
        continue;
      }

      article.embedding = vector;
      article.embeddingStatus = 'done';
      article.embeddingModel = embeddingModel;
      article.embeddingGeneratedAt = new Date();
      article.embeddingError = '';

      uniqueArticles.push(article);
    } catch (error) {
      console.log(`Error en chequeo vectorial para: ${article.title} -> ${error.message}`);
      uniqueArticles.push(article);
    }
  }

  return {
    uniqueArticles,
    vectorSkipped,
  };
}

function buildFallbackReviewedArticles(chunk = [], errorMessage = '') {
  return chunk.map((article) => ({
    ...article,
    aiReviewed: false,
    aiConfidence: 0,
    aiChangedClassification: false,
    aiReason: `AI batch review failed: ${errorMessage}`,
    classificationStatus: 'needs_review',
  }));
}

async function runRssIngestion() {
  const sources = loadSources().filter(
    (source) => source.active && (source.type || 'rss') === 'rss'
  );

  await connectDB();

  try {
    for (const source of sources) {
      let created = 0;
      let skipped = 0;
      let errors = 0;
      let aiBatchCount = 0;

      try {
        const feed = await parser.parseURL(source.url);
        const top50Items = feed.items.slice(0, 50);
        console.log(`${source.name} -> ${top50Items.length} items`);

        const processedArticles = [];

        for (const item of top50Items) {
          try {
            const adapted = adaptRssArticle(item, source);

            const isFallbackImage = adapted.imageUrl === FALLBACK_IMAGE_URL;
            const isAuroraLogo = adapted.imageUrl && adapted.imageUrl.includes('LOGO-AURORA');

            if (isFallbackImage || isAuroraLogo) {
              console.log(`Noticia descartada por no tener imagen valida: ${adapted.title}`);
              continue;
            }

            let contentText = String(adapted.rawSummary || adapted.contentSnippet || '').trim();

            if (contentText.length < 250) {
              console.log(`Rescatando nota corta de ${source.name} (${contentText.length} chars)...`);

              await new Promise((resolve) => setTimeout(resolve, 500));

              try {
                const parsed = await PostlightParser.parse(adapted.url, {
                  headers: {
                    'User-Agent':
                      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  },
                });

                const cleanExtracted = parsed.content
                  ? parsed.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
                  : '';

                if (cleanExtracted.length >= 250) {
                  adapted.rawSummary = cleanExtracted;
                  adapted.contentSnippet = cleanExtracted;
                  console.log(`Rescate exitoso: ${cleanExtracted.length} chars recuperados.`);
                } else {
                  console.log(`Descartada: La nota extraida tiene solo ${cleanExtracted.length} chars.`);
                  continue;
                }
              } catch (parseError) {
                console.log(`Fallo el rescate de Postlight: ${parseError.message}`);
                continue;
              }
            }

            const processed = processArticle(adapted, {
              defaultMinScore: 6,
              maxTags: 3,
            });
            processedArticles.push(processed);
          } catch (error) {
            errors++;
            console.log(`${source.name} -> ${error.message}`);
          }
        }

        const { newArticles, duplicateArticles } = await filterExistingArticles(processedArticles);

        skipped += duplicateArticles.length;

        const { uniqueArticles, vectorSkipped } = await filterVectorDuplicates(newArticles);
        skipped += vectorSkipped;

        const aiChunks = splitIntoChunks(uniqueArticles, AI_BATCH_SIZE);
        aiBatchCount = uniqueArticles.length;

        for (const chunk of aiChunks) {
          try {
            const reviewedArticles = await reviewArticlesWithAIBatch(chunk);
            const batchSaveResult = await saveArticles(reviewedArticles);
            created += batchSaveResult.created;
            skipped += batchSaveResult.skipped;
            errors += batchSaveResult.errors;
          } catch (error) {
            console.log(`${source.name} -> error batch IA: ${error.message}`);

            const fallbackArticles = buildFallbackReviewedArticles(chunk, error.message);
            const fallbackSaveResult = await saveArticles(fallbackArticles);

            created += fallbackSaveResult.created;
            skipped += fallbackSaveResult.skipped;
            errors += fallbackSaveResult.errors;
          }
        }

        console.log(
          `Guardado ${source.name} -> creados: ${created}, omitidos: ${skipped}, errores: ${errors}, IA batch: ${aiBatchCount}`
        );
      } catch (error) {
        console.log(`Error procesando feed ${source.name}: ${error.message}`);
      }
    }
  } finally {
    await mongoose.disconnect();
    console.log('Mongo desconectado');
  }
}

runRssIngestion().catch((error) => {
  console.error('Error general RSS:', error.message);
  process.exit(1);
});