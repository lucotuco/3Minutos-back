const UserPreference = require('../models/UserPreference');
const UserDeliveryRun = require('../models/UserDeliveryRun');
const DigestTestLog = require('../models/DigestTestLog');

const { buildUserNewsDigest } = require('./buildUserNewsDigest');
const { getAlreadyShownHistoryForUser } = require('./getAlreadyShownUrlsForUser');
const { startTimer, timeAsync } = require('./timing');

// 💥 CANDADO EN MEMORIA: Evita que el mismo usuario procese dos resúmenes en paralelo
const activeGenerations = new Map();

async function buildDigestForUser(userId) {
  const userIdStr = String(userId);

  // Si ya hay una generación corriendo, nos colgamos de esa promesa y evitamos gastar en la API
  if (activeGenerations.has(userIdStr)) {
    console.log(`🔒 [LOCK] Esperando generación en curso para user=${userIdStr}...`);
    return activeGenerations.get(userIdStr);
  }

  // Envolvemos toda tu lógica original en una Promesa aislada
  const generationPromise = (async () => {
    const totalTimer = startTimer('buildDigestForUser', { userId: userIdStr });

    try {
      const user = await UserPreference.findById(userId).lean();
      if (!user || !user.isActive) throw new Error('User not found or inactive');

      const history = await getAlreadyShownHistoryForUser(user._id);

      const uniqueAlreadyShownUrls = [...new Set(history.urls)];
      const uniqueAlreadyShownTitles = [...new Set(history.titles)];
      const seenEmbeddings = history.seenEmbeddings || [];

      console.log(`🛡️ [FILTRO ANTI-DUPLICADOS] Excluyendo ${uniqueAlreadyShownUrls.length} URLs y evaluando similitud vectorial contra ${seenEmbeddings.length} vectores.`);

      const digest = await timeAsync(
        'buildUserNewsDigest',
        () => buildUserNewsDigest({
          topics: user.topics || [],
          alreadyShownUrls: uniqueAlreadyShownUrls,
          alreadyShownTitles: uniqueAlreadyShownTitles,
          seenEmbeddings: seenEmbeddings, 
        }),
        {
          userId: String(user._id),
          topics: user.topics || [],
          alreadyShownUrlsCount: uniqueAlreadyShownUrls.length,
        }
      );

      const result = {
        user: {
          id: String(user._id),
          name: user.name,
          deliveryTime: user.deliveryTime,
          topics: user.topics || [],
        },
        digest: {
          items: digest.items || [],
          audioUrl: null,
          audioStorageKey: null,
          audioGeneratedAt: null,
        },
      };

      DigestTestLog.create({
        idUsuario: user._id,
        motivo: 'refresh_test',
        noticias: (digest.items || []).map((item) => ({
          topicoUsuario: item.topic || '',
          queryExpanded: item.queryExpanded || null,
          titulo: item.neutralTitle || item.title || '',
          summaryLead: item.neutralLead || item.lead || '',
          summary: item.neutralSummary || item.summary || '',
          publishedAt: item.publishedAt || null,
          categoria: item.category || '',
          puntajeNoticia: Number(item.rankingScore ?? item.finalScore ?? item.score ?? 0),
          usedFallback: Boolean(item.usedFallback),
          fallbackCategory: item.fallbackCategory || null,
          zona: item.matchZone || null,
          scoreBusqueda: item.matchScore ?? null,
          motivoMatch: item.matchReason || null,
          corralCategoria: item.corralCategory || null,
          candidatosEvaluados: item.candidatesEvaluated || 0,
        })),
      }).catch((logError) => {
        console.error('⚠️ [TEST LOG] No se pudo guardar el log de testing:', logError.message);
      });

      totalTimer.end({
        userId: String(user._id),
        items: digest.items?.length || 0,
        hasAudio: false,
      });

      return result;
    } catch (error) {
      totalTimer.fail(error, { userId: userIdStr });
      throw error;
    }
  })();

  // Guardamos la promesa en el candado
  activeGenerations.set(userIdStr, generationPromise);

  try {
    return await generationPromise;
  } finally {
    // Liberamos el candado SIEMPRE (incluso si falla)
    activeGenerations.delete(userIdStr);
  }
}

module.exports = { buildDigestForUser };