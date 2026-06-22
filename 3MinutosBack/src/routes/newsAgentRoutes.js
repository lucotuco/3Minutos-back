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

function numberFromEnv(name, fallback) {
  const raw = process.env[name];

  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }

  const parsed = Number(raw);

  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return parsed;
}

function booleanFromEnv(name, fallback) {
  const raw = process.env[name];

  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }

  return raw === 'true';
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
          error: 'No hay resumen de hoy para discutir. Generá o actualizá tu resumen primero.',
          code: 'NO_TODAYS_DIGEST',
        });
      }

      console.log('[news-agent] userId:', req.params.userId);
      console.log('[news-agent] digestDate:', digestRun?.deliveryDate);
      console.log(
        '[news-agent] titles:',
        items.map(
          (item) => item.neutralTitle || item.title || item.originalTitle
        )
      );

      const instructions = buildNewsAgentInstructions(contextText);

      const model = process.env.NEWS_AGENT_REALTIME_MODEL || 'gpt-realtime';

      const voice = 'verse';

      const ttlSeconds = Number(
        process.env.NEWS_AGENT_CLIENT_SECRET_TTL_SECONDS || 600
      );

      const vadThreshold = numberFromEnv('NEWS_AGENT_VAD_THRESHOLD', 0.78);
      const vadPrefixPaddingMs = numberFromEnv(
        'NEWS_AGENT_VAD_PREFIX_PADDING_MS',
        300
      );
      const vadSilenceDurationMs = numberFromEnv(
        'NEWS_AGENT_VAD_SILENCE_DURATION_MS',
        900
      );
      const vadIdleTimeoutMs = numberFromEnv(
        'NEWS_AGENT_VAD_IDLE_TIMEOUT_MS',
        12000
      );

      const sessionPayload = {
        type: 'realtime',
        model,
        instructions,
        output_modalities: ['audio'],
        audio: {
          input: {
            transcription: {
              model: process.env.NEWS_AGENT_TRANSCRIPTION_MODEL || 'whisper-1',
              language: 'es',
            },
            turn_detection: {
              type: 'server_vad',

              // Más alto = menos sensible al ruido ambiente.
              threshold: vadThreshold,

              // Conserva un poco de audio antes de detectar habla.
              prefix_padding_ms: vadPrefixPaddingMs,

              // Más alto = espera más silencio antes de cerrar el turno.
              silence_duration_ms: vadSilenceDurationMs,

              // Si el usuario se queda callado mucho tiempo, puede disparar repregunta.
              idle_timeout_ms: vadIdleTimeoutMs,

              // Mantener true para que responda automáticamente cuando el usuario habla.
              create_response: booleanFromEnv(
                'NEWS_AGENT_VAD_CREATE_RESPONSE',
                true
              ),

              // Importante: false evita que un ruidito cancele a Dan mientras habla.
              interrupt_response: booleanFromEnv(
                'NEWS_AGENT_VAD_INTERRUPT_RESPONSE',
                true
              ),
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