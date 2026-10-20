const Article = require('../models/Article');
const { buildEmbeddingText } = require('../embeddings/buildEmbeddingsText');
const { generateArticleEmbedding, EMBEDDING_MODEL } = require('../embeddings/generateArticleEmbeddings');
const { cosineSimilarity } = require('../embeddings/searchArticlesBySimilarity');

/**
 * El vector que la nota ya trae (lo calculó el chequeo de duplicados de la ingesta, filterVectorDuplicates), SOLO si se
 * calculó con exactamente el texto que se va a guardar. Si el texto cambió —la IA le puso otros tags, y los tags forman
 * parte del texto del embedding a propósito— ese vector describe otra cosa y hay que calcular uno nuevo.
 *
 * @param {object} article        la nota, con `embeddingText` ya recalculado para guardar
 * @param {string} previousText   el `embeddingText` con que se calculó el vector que trae
 * @returns {{vector:number[], embeddingModel:string}|null}
 */
function reusableEmbedding(article, previousText) {
  const vector = article?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) return null;
  if (article.embeddingStatus !== 'done' || article.embeddingModel !== EMBEDDING_MODEL) return null;

  const before = String(previousText || '').trim();
  if (!before || before !== String(article.embeddingText || '').trim()) return null;
  return { vector, embeddingModel: article.embeddingModel };
}

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
  const previousText = article.embeddingText;
  article.embeddingText = buildEmbeddingText(article);
  let newVector = [];
  let embeddingModel = '';
  let embeddingReused = false;

  try {
    // Con el mismo texto no se paga otra llamada a OpenAI por el mismo vector.
    const reused = reusableEmbedding(article, previousText);
    const result = reused || await generateArticleEmbedding(article);
    embeddingReused = Boolean(reused);
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
    embeddingReused,
  };
}

module.exports = { saveNormalizedArticle, reusableEmbedding };