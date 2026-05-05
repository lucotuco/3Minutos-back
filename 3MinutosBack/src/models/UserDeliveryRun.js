const mongoose = require('mongoose');

const UserDeliveryRunSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'UserPreference',
      required: true,
      index: true,
    },
    deliveryDate: {
      type: String,
      required: true,
      index: true,
    },
    deliveryTime: {
      type: String,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['created', 'preparing', 'prepared', 'sent', 'error'],
      default: 'created',
      index: true,
    },
    digest: {
      type: Object,
      default: null,
    },
    preferencesSnapshot: {
      topics: {
        type: [String],
        default: [],
      },
      deliveryTime: {
        type: String,
        default: '08:00',
      },
    },
    preparedAt: {
      type: Date,
      default: null,
    },
    sentAt: {
      type: Date,
      default: null,
    },
    errorMessage: {
      type: String,
      default: '',
    },
    notificationSentAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

UserDeliveryRunSchema.index(
  { userId: 1, deliveryDate: 1, deliveryTime: 1 },
  { unique: true }
);

module.exports = mongoose.model(
  'UserDeliveryRun',
  UserDeliveryRunSchema,
  'user_delivery_runs'
);