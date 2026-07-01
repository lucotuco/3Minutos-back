const UserShownArticle = require('../models/UserShownArticle');

async function getAlreadyShownUrlsForUser(userId) {
  const items = await UserShownArticle.find({ userId }).select('articleUrl -_id').lean();
  return items.map((item) => item.articleUrl).filter(Boolean);
}

async function getAlreadyShownHistoryForUser(userId) {
  const items = await UserShownArticle.find({ userId })
    .select('articleUrl title -_id')
    .lean();

  return {
    urls: items.map((item) => item.articleUrl).filter(Boolean),
    titles: items.map((item) => item.title).filter(Boolean),
  };
}

module.exports = {
  getAlreadyShownUrlsForUser,
  getAlreadyShownHistoryForUser, // <-- No te olvides de exportarla
};