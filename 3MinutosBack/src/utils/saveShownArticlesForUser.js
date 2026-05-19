const UserShownArticle = require('../models/UserShownArticle');
const { getLocalDateString } = require('./dateHelpers');

async function saveShownArticlesForUser(
  userId,
  digestItems = [],
  { shownDate = getLocalDateString(new Date()) } = {}
) {
  const ops = [];

  for (const item of digestItems) {
    if (!item?.url) continue;

    ops.push({
      updateOne: {
        filter: {
          userId,
          shownDate,
          articleUrl: item.url,
        },
        update: {
          $setOnInsert: {
            userId,
            articleId: item.articleId || null,
            articleUrl: item.url,
            title: item.title || '',
            summary: item.summary || '',
            topic: item.topic || '',
            category:   item.category   || '',
            region: item.region || '',
            section: item.section || '',
            shownDate,
            shownAt: new Date(),
          },
        },
        upsert: true,
      },
    });
  }

  if (!ops.length) return;

  await UserShownArticle.bulkWrite(ops);
}

module.exports = {
  saveShownArticlesForUser,
};