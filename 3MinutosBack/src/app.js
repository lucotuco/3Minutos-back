const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const newsAgentRoutes = require('./routes/newsAgentRoutes');
const articleRoutes = require('./routes/articleRoutes');
const userRoutes = require('./routes/userRoutes');

const app = express();

function getAllowedOrigins() {
  return String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const allowedOrigins = getAllowedOrigins();

app.use(helmet());

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);

      if (process.env.NODE_ENV !== 'production' && allowedOrigins.length === 0) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(
  express.json({
    limit: '100kb',
  })
);

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: 'Too many requests',
      code: 'RATE_LIMITED',
    },
  })
);

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: '3Minutos backend',
  });
});

app.use('/articles', articleRoutes);
app.use('/users', userRoutes);
app.use('/users', newsAgentRoutes);

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    code: 'NOT_FOUND',
  });
});

app.use((error, req, res, next) => {
  console.error('[Unhandled error]', error);

  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
});

module.exports = app;