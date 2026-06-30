const express = require('express');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Article = require('../models/Article');
const { generateDigestAudioFile } = require('../audio/generateDigestAudioFile');
const { uploadDigestAudio } = require('../audio/uploadDigestAudio');

const UserPreference = require('../models/UserPreference');
const UserShownArticle = require('../models/UserShownArticle');
const UserDeliveryRun = require('../models/UserDeliveryRun');

const { buildDigestForUser } = require('../utils/buildDigestForUser');
const { saveShownArticlesForUser } = require('../utils/saveShownArticlesForUser');
const { getLocalDateString } = require('../utils/dateHelpers');
const { publicUser } = require('../utils/publicUser');
const {
  authRequired,
  requireSameUserParam,
  signUserToken,
} = require('../middleware/auth');

const router = express.Router();

const expensiveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many expensive requests',
    code: 'EXPENSIVE_RATE_LIMITED',
  },
});

function normalizeTopics(topics) {
  if (!Array.isArray(topics)) return [];

  const cleanTopics = topics
    .map((topic) => String(topic || '').trim())
    .filter(Boolean)
    .map((topic) => topic.replace(/\s+/g, ' '))
    .filter((topic) => topic.length >= 2 && topic.length <= 40)
    .slice(0, 3);

  return [...new Set(cleanTopics)];
}

function validateDeliveryTime(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) return false;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

function normalizeExpoPushToken(body = {}) {
  const rawToken =
    body.expoPushToken ||
    body.pushToken ||
    body.token ||
    body.devicePushToken ||
    '';

  return String(rawToken || '').trim();
}

function isValidExpoPushToken(token) {
  if (!token || typeof token !== 'string') return false;

  const cleanToken = token.trim();

  return (
    cleanToken.startsWith('ExponentPushToken[') ||
    cleanToken.startsWith('ExpoPushToken[')
  );
}

function validateUserId(req, res, next) {
  if (!mongoose.Types.ObjectId.isValid(req.params.userId)) {
    return res.status(400).json({
      error: 'Invalid user id',
      code: 'INVALID_USER_ID',
    });
  }

  return next();
}

function userNotFoundResponse(res) {
  return res.status(404).json({
    error: 'User not found',
    code: 'USER_NOT_FOUND',
    shouldClearLocalSession: true,
  });
}

async function findUserOr404(userId, res) {
  const user = await UserPreference.findById(userId).lean();

  if (!user) {
    userNotFoundResponse(res);
    return null;
  }

  return user;
}

async function savePreparedDigestRun(user, digest, deliveryDate) {
  const now = new Date();

  return UserDeliveryRun.findOneAndUpdate(
    {
      userId: user._id,
      deliveryDate,
      deliveryTime: user.deliveryTime,
    },
    {
      $set: {
        status: 'prepared',
        digest,
        preparedAt: now,
        errorMessage: '',
        preferencesSnapshot: {
          topics: user.topics || [],
          deliveryTime: user.deliveryTime,
        },
      },
    },
    {
      returnDocument: 'after',
      upsert: true,
      setDefaultsOnInsert: true,
    }
  ).lean();
}

async function triggerBackgroundDigestRefresh(user, deliveryDate) {
  try {
    const digest = await buildDigestForUser(user._id);
    await savePreparedDigestRun(user, digest, deliveryDate);

    console.log(
      `✅ Digest refrescado en background para user=${String(user._id)}`
    );
  } catch (error) {
    console.error(
      `❌ Error refrescando digest en background para user=${String(user._id)}:`,
      error
    );

    await UserDeliveryRun.findOneAndUpdate(
      {
        userId: user._id,
        deliveryDate,
        deliveryTime: user.deliveryTime,
      },
      {
        $set: {
          status: 'error',
          errorMessage: 'Background digest refresh failed',
          preferencesSnapshot: {
            topics: user.topics || [],
            deliveryTime: user.deliveryTime,
          },
        },
      },
      {
        upsert: true,
        setDefaultsOnInsert: true,
      }
    );
  }
}

function isRefreshOnCooldown(latestRun) {
  if (!latestRun?.preparedAt) return false;

  const cooldownSeconds = Number(process.env.REFRESH_COOLDOWN_SECONDS || 600);
  const lastPreparedAt = new Date(latestRun.preparedAt).getTime();

  if (!Number.isFinite(lastPreparedAt)) return false;

  const elapsedSeconds = (Date.now() - lastPreparedAt) / 1000;

  return elapsedSeconds < cooldownSeconds;
}

router.post('/preferences', async (req, res) => {
  try {
    const {
      name = '',
      topics = [],
      deliveryTime = '08:00',
      isActive = true,
    } = req.body || {};

    const cleanName = String(name).trim().replace(/\s+/g, ' ');
    const cleanTopics = normalizeTopics(topics);
    const expoPushToken = normalizeExpoPushToken(req.body);

    if (!cleanName || cleanName.length > 60) {
      return res.status(400).json({
        error: 'name is required and must be at most 60 characters',
        code: 'INVALID_NAME',
      });
    }

    if (cleanTopics.length !== 3) {
      return res.status(400).json({
        error: 'topics must contain exactly 3 unique items between 2 and 40 characters',
        code: 'INVALID_TOPICS',
      });
    }

    if (!validateDeliveryTime(deliveryTime)) {
      return res.status(400).json({
        error: 'invalid deliveryTime format, expected HH:MM',
        code: 'INVALID_DELIVERY_TIME',
      });
    }

    if (expoPushToken && !isValidExpoPushToken(expoPushToken)) {
      return res.status(400).json({
        error: 'invalid expoPushToken format',
        code: 'INVALID_PUSH_TOKEN',
      });
    }

    const user = await UserPreference.create({
      name: cleanName,
      topics: cleanTopics,
      deliveryTime,
      isActive: Boolean(isActive),
      expoPushToken: expoPushToken || null,
    });

    const token = signUserToken(user._id);

    return res.status(201).json({
      user: publicUser(user),
      authToken: token,
    });
  } catch (error) {
    console.error('[POST /users/preferences]', error);

    return res.status(500).json({
      error: 'Failed to create preferences',
      code: 'CREATE_PREFERENCES_FAILED',
    });
  }
});

router.get(
  '/preferences/:userId',
  authRequired,
  validateUserId,
  requireSameUserParam('userId'),
  async (req, res) => {
    try {
      const user = await findUserOr404(req.params.userId, res);
      if (!user) return;

      return res.json({
        user: publicUser(user),
      });
    } catch (error) {
      console.error('[GET /users/preferences/:userId]', error);

      return res.status(500).json({
        error: 'Failed to fetch preferences',
        code: 'FETCH_PREFERENCES_FAILED',
      });
    }
  }
);

router.patch(
  '/preferences/:userId',
  authRequired,
  validateUserId,
  requireSameUserParam('userId'),
  async (req, res) => {
    try {
      const updates = {};
      const { name, topics, deliveryTime, isActive } = req.body || {};
      const expoPushToken = normalizeExpoPushToken(req.body);

      if (name !== undefined) {
        const cleanName = String(name).trim().replace(/\s+/g, ' ');

        if (!cleanName || cleanName.length > 60) {
          return res.status(400).json({
            error: 'name must be between 1 and 60 characters',
            code: 'INVALID_NAME',
          });
        }

        updates.name = cleanName;
      }

      if (topics !== undefined) {
        const cleanTopics = normalizeTopics(topics);

        if (cleanTopics.length !== 3) {
          return res.status(400).json({
            error: 'topics must contain exactly 3 unique items between 2 and 40 characters',
            code: 'INVALID_TOPICS',
          });
        }

        updates.topics = cleanTopics;
      }

      if (deliveryTime !== undefined) {
        if (!validateDeliveryTime(deliveryTime)) {
          return res.status(400).json({
            error: 'invalid deliveryTime format, expected HH:MM',
            code: 'INVALID_DELIVERY_TIME',
          });
        }

        updates.deliveryTime = deliveryTime;
      }

      if (isActive !== undefined) {
        updates.isActive = Boolean(isActive);
      }

      if (expoPushToken) {
        if (!isValidExpoPushToken(expoPushToken)) {
          return res.status(400).json({
            error: 'invalid expoPushToken format',
            code: 'INVALID_PUSH_TOKEN',
          });
        }

        updates.expoPushToken = expoPushToken;
      }

      const user = await UserPreference.findByIdAndUpdate(
        req.params.userId,
        {
          $set: updates,
        },
        {
          returnDocument: 'after',
          runValidators: true,
        }
      ).lean();

      if (!user) {
        return userNotFoundResponse(res);
      }

      return res.json({
        user: publicUser(user),
      });
    } catch (error) {
      console.error('[PATCH /users/preferences/:userId]', error);

      return res.status(500).json({
        error: 'Failed to update preferences',
        code: 'UPDATE_PREFERENCES_FAILED',
      });
    }
  }
);

router.patch(
  '/preferences/:userId/push-token',
  authRequired,
  validateUserId,
  requireSameUserParam('userId'),
  async (req, res) => {
    try {
      const expoPushToken = normalizeExpoPushToken(req.body);

      if (!expoPushToken) {
        return res.status(400).json({
          error: 'expoPushToken is required',
          code: 'PUSH_TOKEN_REQUIRED',
        });
      }

      if (!isValidExpoPushToken(expoPushToken)) {
        return res.status(400).json({
          error: 'invalid expoPushToken format',
          code: 'INVALID_PUSH_TOKEN',
        });
      }

      const user = await UserPreference.findByIdAndUpdate(
        req.params.userId,
        {
          $set: {
            expoPushToken,
          },
        },
        {
          returnDocument: 'after',
          runValidators: true,
        }
      ).lean();

      if (!user) {
        return userNotFoundResponse(res);
      }

      return res.json({
        ok: true,
        userId: String(user._id),
      });
    } catch (error) {
      console.error('[PATCH /users/preferences/:userId/push-token]', error);

      return res.status(500).json({
        error: 'Failed to save push token',
        code: 'SAVE_PUSH_TOKEN_FAILED',
      });
    }
  }
);

router.get(
  '/:userId/digest',
  authRequired,
  validateUserId,
  requireSameUserParam('userId'),
  expensiveLimiter,
  async (req, res) => {
    try {
      const user = await findUserOr404(req.params.userId, res);
      if (!user) return;

      if (!user.isActive) {
        return res.status(400).json({
          error: 'User is inactive',
          code: 'USER_INACTIVE',
        });
      }

      const deliveryDate = getLocalDateString(new Date());

      const todaysPreparedRun = await UserDeliveryRun.findOne({
        userId: user._id,
        deliveryDate,
        status: {
          $in: ['prepared', 'sent'],
        },
        digest: {
          $ne: null,
        },
      })
        .sort({
          preparedAt: -1,
          createdAt: -1,
        })
        .lean();

      if (todaysPreparedRun?.digest) {
        return res.json(todaysPreparedRun.digest);
      }

      const latestPreparedRun = await UserDeliveryRun.findOne({
        userId: user._id,
        status: {
          $in: ['prepared', 'sent'],
        },
        digest: {
          $ne: null,
        },
      })
        .sort({
          preparedAt: -1,
          createdAt: -1,
        })
        .lean();

      if (latestPreparedRun?.digest) {
        triggerBackgroundDigestRefresh(user, deliveryDate);
        return res.json(latestPreparedRun.digest);
      }

      const digest = await buildDigestForUser(user._id);
      await savePreparedDigestRun(user, digest, deliveryDate);

      return res.json(digest);
    } catch (error) {
      console.error('[GET /users/:userId/digest]', error);

      return res.status(500).json({
        error: 'Failed to build digest',
        code: 'BUILD_DIGEST_FAILED',
      });
    }
  }
);

router.post(
  '/:userId/digest/refresh',
  authRequired,
  validateUserId,
  requireSameUserParam('userId'),
  expensiveLimiter,
  async (req, res) => {
    try {
      const user = await findUserOr404(req.params.userId, res);
      if (!user) return;

      if (!user.isActive) {
        return res.status(400).json({
          error: 'User is inactive',
          code: 'USER_INACTIVE',
        });
      }

      const latestPreparedRun = await UserDeliveryRun.findOne({
        userId: user._id,
        digest: {
          $ne: null,
        },
      })
        .sort({
          preparedAt: -1,
          createdAt: -1,
        })
        .lean();

      if (isRefreshOnCooldown(latestPreparedRun)) {
        return res.status(429).json({
          error: 'Digest refresh is on cooldown',
          code: 'DIGEST_REFRESH_COOLDOWN',
        });
      }

      const deliveryDate = getLocalDateString(new Date());
      const digest = await buildDigestForUser(user._id);

      await savePreparedDigestRun(user, digest, deliveryDate);

      return res.json(digest);
    } catch (error) {
      console.error('[POST /users/:userId/digest/refresh]', error);

      return res.status(500).json({
        error: 'Failed to refresh digest',
        code: 'REFRESH_DIGEST_FAILED',
      });
    }
  }
);

router.post(
  '/:userId/digest/mark-shown',
  authRequired,
  validateUserId,
  requireSameUserParam('userId'),
  async (req, res) => {
    try {
      const user = await findUserOr404(req.params.userId, res);
      if (!user) return;

      const { items = [], shownDate } = req.body || {};

      if (!Array.isArray(items)) {
        return res.status(400).json({
          error: 'items must be an array',
          code: 'INVALID_ITEMS',
        });
      }

      if (items.length > 20) {
        return res.status(400).json({
          error: 'items cannot contain more than 20 articles',
          code: 'TOO_MANY_ITEMS',
        });
      }

      const effectiveShownDate = shownDate || getLocalDateString(new Date());

      await saveShownArticlesForUser(user._id, items, {
        shownDate: effectiveShownDate,
      });

      return res.json({
        ok: true,
      });
    } catch (error) {
      console.error('[POST /users/:userId/digest/mark-shown]', error);

      return res.status(500).json({
        error: 'Failed to mark shown articles',
        code: 'MARK_SHOWN_FAILED',
      });
    }
  }
);

router.get(
  '/:userId/shown-articles',
  authRequired,
  validateUserId,
  requireSameUserParam('userId'),
  async (req, res) => {
    try {
      const user = await findUserOr404(req.params.userId, res);
      if (!user) return;

      const articles = await UserShownArticle.find({
        userId: user._id,
      })
        .sort({
          shownAt: -1,
          createdAt: -1,
        })
        .limit(200)
        .lean();

      return res.json({
        items: articles,
      });
    } catch (error) {
      console.error('[GET /users/:userId/shown-articles]', error);

      return res.status(500).json({
        error: 'Failed to fetch shown articles',
        code: 'FETCH_SHOWN_ARTICLES_FAILED',
      });
    }
  }
);
router.post(
  '/:userId/digest/play',
  authRequired,
  validateUserId,
  requireSameUserParam('userId'),
  async (req, res) => {
    console.log('\n🚀 [CHECKPOINT 1] Entrando al endpoint /play on-demand');
    console.log(`   - Param userId recibido: ${req.params.userId}`);

    try {
      // 1. Buscar Usuario
      const user = await UserPreference.findById(req.params.userId);
      if (!user) {
        console.log('❌ [CHECKPOINT 2] Usuario no encontrado en la base de datos');
        return userNotFoundResponse(res);
      }
      console.log(`✅ [CHECKPOINT 2] Usuario encontrado: ${user.name}`);

      if (!user.isActive) {
        console.log('❌ [CHECKPOINT 2.1] El usuario está inactivo');
        return res.status(400).json({ error: 'User is inactive', code: 'USER_INACTIVE' });
      }

      // 2. Buscar el Digest del día
      const deliveryDate = getLocalDateString(new Date());
      console.log(`🔍 [CHECKPOINT 3] Buscando run preparado para la fecha de hoy: ${deliveryDate}`);

      const todaysPreparedRun = await UserDeliveryRun.findOne({
        userId: user._id,
        deliveryDate,
        status: { $in: ['prepared', 'sent'] },
        digest: { $ne: null },
      })
        .sort({ preparedAt: -1, createdAt: -1 })
        .lean();

      let activeDigest = todaysPreparedRun?.digest;

      if (activeDigest) {
        console.log('✅ [CHECKPOINT 4] Se encontró el run preparado de HOY');
      } else {
        console.log('⚠️ [CHECKPOINT 4] No se encontró run para hoy. Buscando el último digest histórico disponible...');
        const latestPreparedRun = await UserDeliveryRun.findOne({
          userId: user._id,
          status: { $in: ['prepared', 'sent'] },
          digest: { $ne: null },
        })
          .sort({ preparedAt: -1, createdAt: -1 })
          .lean();
        
        activeDigest = latestPreparedRun?.digest;
      }

      if (!activeDigest) {
        console.log('❌ [CHECKPOINT 5] Error crítico: No se encontró ningún digest (ni de hoy ni histórico) para este usuario');
        return res.status(404).json({
          error: 'No active digest found for this user',
          code: 'NO_DIGEST_FOUND',
        });
      }

      // 3. Extracción Segura de Items
      console.log('🔍 [CHECKPOINT 6] Estructura de activeDigest detectada. Extrayendo artículos...');
      let digestItems = [];
      
      if (activeDigest.digest && Array.isArray(activeDigest.digest.items)) {
        console.log('   -> Caso A: Los artículos están anidados en activeDigest.digest.items');
        digestItems = activeDigest.digest.items;
      } else if (Array.isArray(activeDigest.items)) {
        console.log('   -> Caso B: Los artículos están en la raíz activeDigest.items');
        digestItems = activeDigest.items;
      }

      console.log(`📊 [CHECKPOINT 7] Cantidad de noticias extraídas: ${digestItems.length}`);
      if (digestItems.length === 0) {
        console.log('❌ [CHECKPOINT 7.1] Deteniendo ejecución: La lista de noticias está vacía');
        return res.status(404).json({
          error: 'No active digest items found to play',
          code: 'NO_DIGEST_ITEMS',
        });
      }

      const playlistUrls = [];

      // ========================================================
      // 🧩 BLOQUE A: AUDIO 0 - SALUDO PERSONALIZADO
      // ========================================================
      let greetingUrl = user.greetingAudioUrl;
      console.log(`🔍 [CHECKPOINT 8] Verificando Saludo (Audio 0). URL en BD: ${greetingUrl || 'Ninguna'}`);

      if (!greetingUrl || user.name !== user.greetingNameUsed) {
        console.log(`🎙️ [SALUDO] Generando audio de saludo por primera vez para: ${user.name}`);
        const greetingText = `Hola ${user.name}. Estas son tus noticias curadas para hoy.`;
        const tempGreetingPath = path.join(os.tmpdir(), `greeting-${user._id}-${Date.now()}.mp3`);
        const storageKey = `greetings/user-${user._id}`;

        console.log('   -> Llamando a Google Cloud TTS para el saludo...');
        await generateDigestAudioFile({ script: greetingText, outputPath: tempGreetingPath });
        
        console.log('   -> Subiendo saludo a Cloudinary...');
        const uploadRes = await uploadDigestAudio(tempGreetingPath, storageKey);

        if (fs.existsSync(tempGreetingPath)) fs.unlinkSync(tempGreetingPath);

        greetingUrl = uploadRes?.audioUrl || null;
        console.log(`   -> Saludo creado exitosamente. URL: ${greetingUrl}`);
        
        if (greetingUrl) {
          user.greetingAudioUrl = greetingUrl;
          user.greetingNameUsed = user.name;
          await user.save();
          console.log('   -> Usuario actualizado con su nueva URL de saludo permanente');
        }
      } else {
        console.log('🎯 [SALUDO - CACHÉ] Reutilizando saludo permanente guardado en el usuario');
      }
      
      if (greetingUrl) playlistUrls.push(greetingUrl);

      // ========================================================
      // 🧩 BLOQUE B: LAS NOTICIAS (Caché por artículo)
      // ========================================================
      console.log('🔍 [CHECKPOINT 9] Iniciando procesamiento del bloque de noticias...');
      
      for (let i = 0; i < digestItems.length; i++) {
        const item = digestItems[i];
        console.log(`   👉 Procesando ítem [${i}]: ID de artículo en digest: ${item.articleId}`);

        if (!item.articleId) {
          console.log(`      ⚠️ Saltando ítem [${i}]: No tiene articleId válido`);
          continue;
        }

        const article = await Article.findById(item.articleId);
        if (!article) {
          console.log(`      ⚠️ Saltando ítem [${i}]: El artículo no existe en la colección 'articles'`);
          continue;
        }

        let articleAudioUrl = article.audioUrl;
        console.log(`      - Estado de audio en BD para esta noticia: ${articleAudioUrl || 'No generado (MISS)'}`);

        if (!articleAudioUrl) {
          const textToSpeak = article.neutralSummary || item.summary || article.title;
          console.log(`      🎙️ [NOTICIA] Enviando texto a Google TTS (${textToSpeak.length} caracteres)...`);
          
          const tempArticlePath = path.join(os.tmpdir(), `article-${article._id}-${Date.now()}.mp3`);
          const storageKey = `articles-chunks/audio-${article._id}`;

          await generateDigestAudioFile({ script: textToSpeak, outputPath: tempArticlePath });
          
          console.log('      - Subiendo fragmento de noticia a Cloudinary...');
          const uploadRes = await uploadDigestAudio(tempArticlePath, storageKey);

          if (fs.existsSync(tempArticlePath)) fs.unlinkSync(tempArticlePath);

          articleAudioUrl = uploadRes?.audioUrl || null;
          console.log(`      - Fragmento creado exitosamente. URL: ${articleAudioUrl}`);

          if (articleAudioUrl) {
            article.audioUrl = articleAudioUrl;
            await article.save();
            console.log('      - Artículo actualizado en la BD con su nueva URL de audio');
          }
        } else {
          console.log(`      🎯 [NOTICIA - CACHÉ] Audio reutilizado de un usuario anterior`);
        }

        if (articleAudioUrl) {
          playlistUrls.push(articleAudioUrl);
        }
      }

      // 4. Respuesta de seguridad final
      const cleanPlaylist = playlistUrls.filter(Boolean);
      console.log(`🏁 [CHECKPOINT 10] Proceso terminado. Playlist armada con ${cleanPlaylist.length} enlaces válidos.`);
      console.log('   -> Contenido enviado al front:', cleanPlaylist);

      return res.json({
        success: true,
        playlist: cleanPlaylist,
      });

    } catch (error) {
      console.error('\n💥 CRASH DETECTADO EN EL ENDPOINT /PLAY:');
      console.error(error.stack); // Esto nos va a imprimir el error exacto con número de línea
      return res.status(500).json({
        error: 'Failed to process on-demand audio playlist',
        code: 'PLAY_AUDIO_FAILED',
        details: error.message
      });
    }
  }
);

module.exports = router;