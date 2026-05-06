const path = require('path');
const dotenv = require('dotenv');
const OpenAI = require('openai');

if (process.env.NODE_ENV !== 'production') {
  dotenv.config({
    path: path.resolve(__dirname, '../../.env'),
  });
}

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  throw new Error('Falta OPENAI_API_KEY');
}

const openai = new OpenAI({
  apiKey,
});

module.exports = {
  openai,
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-5-mini',
};