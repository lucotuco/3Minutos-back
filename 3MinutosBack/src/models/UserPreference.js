const mongoose = require('mongoose');

const UserPreferenceSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    topics: {
      type: [String],
      default: [],
      validate: {
        validator: (value) =>
          Array.isArray(value) &&
          value.length === 3 &&
          value.every((item) => typeof item === 'string' && item.trim().length > 0),
        message: 'topics must contain exactly 3 non-empty items',
      },
    },
    deliveryTime: {
      type: String,
      default: '08:00',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    expoPushToken: {
      type: String,
      default: null,
    },
    greetingAudioUrl: {
      type: String,
      default: null,
    },
    greetingNameUsed: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model(
  'UserPreference',
  UserPreferenceSchema,
  'user_preferences'
);