const path = require('path');
const dotenv = require('dotenv');
const OpenAI = require('openai');

if (process.env.NODE_ENV !== 'production') {
  dotenv.config({
    path: path.resolve(__dirname, '../../.env'),
  });
}

const apiKeyEmbeddings = process.env.OPENAI_API_KEY_EMBEDDINGS;
const apiKeyReview = process.env.OPENAI_API_KEY_REVIEW;

if (!apiKeyEmbeddings) {
  throw new Error('Falta OPENAI_API_KEY_EMBEDDINGS');
}

if (!apiKeyReview) {
  throw new Error('Falta OPENAI_API_KEY_REVIEW');
}

const openaiEmbeddings = new OpenAI({
  apiKey: apiKeyEmbeddings,
});

const openaiReview = new OpenAI({
  apiKey: apiKeyReview,
});

module.exports = {
  openaiEmbeddings,
  openaiReview,
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
};