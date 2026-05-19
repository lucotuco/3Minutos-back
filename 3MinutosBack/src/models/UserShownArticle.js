const mongoose = require('mongoose');

const UserShownArticleSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    articleId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    articleUrl: {
      type: String,
      required: true,
      index: true,
    },
    title: {
      type: String,
      default: '',
    },
    summary: {
      type: String,
      default: '',
    },
    topic: {
      type: String,
      default: '',
    },
    category: {
      type: String,
      default: '',
    },
    region: {
      type: String,
      default: '',
    },
    section: {
      type: String,
      default: '',
    },
    shownDate: {
      type: String,
      required: true,
      index: true,
    },
    shownAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true }
);

UserShownArticleSchema.index(
  { userId: 1, shownDate: 1, articleUrl: 1 },
  { unique: true }
);

module.exports = mongoose.model(
  'UserShownArticle',
  UserShownArticleSchema,
  'user_shown_articles'
);