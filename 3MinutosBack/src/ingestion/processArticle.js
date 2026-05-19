const { normalizeText } = require('../utils/normalizeText');

function processArticle(article = {}) {
  const processed = {
    ...article,
  };

  processed.normalizedTitle = normalizeText(processed.title || '');
  processed.section = '';
  processed.region = '';
  processed.tags = [];
  processed.tagScores = {};

  processed.aiReviewed = false;
  processed.aiConfidence = 0;
  processed.topicStatus = 'pending';
  processed.topic = '';
  processed.aiChangedClassification = false;
  processed.aiReason = '';
  processed.classificationStatus = 'pending_ai';
  processed.classificationVersion = 'v2';

  delete processed._sourceMeta;

  return processed;
}

module.exports = {
  processArticle,
};