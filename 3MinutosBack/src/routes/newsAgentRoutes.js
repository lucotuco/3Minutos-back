const express = require('express');
const rateLimit = require('express-rate-limit');

const {
  authRequired,
  requireSameUserParam,
} = require('../middleware/auth');

const {
  buildNewsAgentContext,
  buildNewsAgentInstructions,
} = require('../utils/newsAgentContext');

const router = express.Router();

const newsAgentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many news agent requests',
    code: 'NEWS_AGENT_RATE_LIMITED',
  },
});

function getClientSecretValue(payload) {
  if (!payload) return '';

  if (typeof payload.value === 'string') {
    return payload.value;
  }

  if (typeof payload.client_secret?.value === 'string') {
    return payload.client_secret.value;
  }

  return '';
}

router.get(
  '/:userId/news-agent/client-secret',
  authRequired,
  requireSameUserParam('userId'),
  newsAgentLimiter,
  async (req, res) => {
    try {
      if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({
          error: 'OPENAI_API_KEY is not configured',
          code: 'OPENAI_API_KEY_MISSING',
        });
      }

      const { contextText, digestRun, items, hasTodaysDigest } =
        await buildNewsAgentContext(req.params.userId);

      if (!hasTodaysDigest) {
        console.log('[news-agent] No todays digest found', {
          userId: req.params.userId,
        });

        return res.status(409).json({
          error:
            'No hay digest de hoy para discutir. Generá o actualizá tu digest primero.',
          code: 'NO_TODAYS_DIGEST',
        });
      }

      console.log('[news-agent] userId:', req.params.userId);
      console.log('[news-agent] digestDate:', digestRun?.deliveryDate);
      console.log(
        '[news-agent] titles:',
        items.map((item) => item.neutralTitle || item.title || item.originalTitle)
      );

      const instructions = buildNewsAgentInstructions(contextText);

      const model = process.env.NEWS_AGENT_REALTIME_MODEL || 'gpt-realtime';
      const voice =
  process.env.NEWS_AGENT_REALTIME_VOICE ||
  process.env.OPENAI_TTS_VOICE ||
  'verse';
      const ttlSeconds = Number(
        process.env.NEWS_AGENT_CLIENT_SECRET_TTL_SECONDS || 600
      );

      const sessionPayload = {
        type: 'realtime',
        model,
        instructions,
        audio: {
          input: {
            transcription: {
              model: 'whisper-1',
              language: 'es',
            },
          },
          output: {
            voice,
          },
        },
      };

      const response = await fetch(
        'https://api.openai.com/v1/realtime/client_secrets',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            expires_after: {
              anchor: 'created_at',
              seconds: ttlSeconds,
            },
            session: sessionPayload,
          }),
        }
      );

      const raw = await response.text();

      if (!response.ok) {
        console.error('[news-agent] OpenAI client secret error:', raw);

        return res.status(500).json({
          error: 'Could not create Realtime client secret',
          code: 'REALTIME_CLIENT_SECRET_FAILED',
        });
      }

      const payload = raw ? JSON.parse(raw) : {};
      const clientSecret = getClientSecretValue(payload);

      if (!clientSecret) {
        console.error('[news-agent] Unexpected client secret payload:', payload);

        return res.status(500).json({
          error: 'Invalid Realtime client secret response',
          code: 'INVALID_REALTIME_CLIENT_SECRET',
        });
      }

      return res.json({
        ok: true,
        clientSecret,
        model,
        digestDate: digestRun?.deliveryDate || null,
        contextSource: 'today',
        itemCount: items.length,
      });
    } catch (error) {
      console.error('[GET /users/:userId/news-agent/client-secret]', error);

      return res.status(500).json({
        error: 'Failed to create news agent session',
        code: 'NEWS_AGENT_SESSION_FAILED',
      });
    }
  }
);

module.exports = router;