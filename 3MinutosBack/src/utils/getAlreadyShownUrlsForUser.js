const UserShownArticle = require('../models/UserShownArticle');
const UserDeliveryRun = require('../models/UserDeliveryRun');
const Article = require('../models/Article');

// Ventana del historial. Una nota que el usuario vio hace más de 24 h ya no podría volver a elegirse
// por edad (el tope de edad es 24 h); 48 h cubre además las notas nuevas de una MISMA historia que
// aparecen al día siguiente ("misma historia" = coseno de embeddings, ver eligibility.js).
const HISTORY_WINDOW_HOURS = 48;

// Tope de notas del historial. Con 3 temas por digest y unos pocos refrescos por día, 150 cubre 48 h de sobra
// y acota el costo de traer los embeddings (antes: las últimas 30 de cualquier fecha).
const HISTORY_MAX_NOTES = 150;

async function getAlreadyShownUrlsForUser(userId) {
  const items = await UserShownArticle.find({ userId }).select('articleUrl -_id').lean();
  return items.map((item) => item.articleUrl).filter(Boolean);
}

/**
 * Lo que el usuario ya vio en las últimas `hours` horas (máximo `cap` notas, las más recientes primero):
 *   urls            para no repetir la misma nota
 *   titles          para los logs
 *   seenEmbeddings  [{ title, vector }] para descartar "la misma historia" contada por otro medio
 *
 * `models` solo se usa en los tests ({ UserShownArticle, Article } falsos).
 */
async function getAlreadyShownHistoryForUser(userId, {
  now = Date.now(),
  hours = HISTORY_WINDOW_HOURS,
  cap = HISTORY_MAX_NOTES,
  models = {},
} = {}) {
  const Shown = models.UserShownArticle || UserShownArticle;
  const Articles = models.Article || Article;

  // 1. Lo que vio en la app dentro de la ventana
  const since = new Date(now - hours * 3600e3);
  const shownItems = await Shown.find({ userId, shownAt: { $gte: since } })
    .sort({ shownAt: -1 })
    .limit(cap)
    .select('articleUrl articleId title -_id')
    .lean();

  const urls = [...new Set(shownItems.map((i) => i.articleUrl).filter(Boolean))];
  const titles = [...new Set(shownItems.map((i) => i.title).filter(Boolean))];
  const articleIds = [...new Set(shownItems.map((i) => i.articleId).filter(Boolean).map(String))];

  // 2. Los embeddings reales de esas notas
  let seenEmbeddings = [];
  if (articleIds.length > 0) {
    const pastArticles = await Articles.find({ _id: { $in: articleIds } })
      .select('title embedding -_id')
      .lean();

    seenEmbeddings = pastArticles
      .filter((a) => Array.isArray(a.embedding) && a.embedding.length > 0)
      .map((a) => ({ title: a.title, vector: a.embedding }));
  }

  return { urls, titles, seenEmbeddings };
}

module.exports = {
  HISTORY_WINDOW_HOURS,
  HISTORY_MAX_NOTES,
  getAlreadyShownUrlsForUser,
  getAlreadyShownHistoryForUser,
};
