const UserPreference = require('../models/UserPreference');
const UserDeliveryRun = require('../models/UserDeliveryRun');
const DigestTestLog = require('../models/DigestTestLog');

const { buildUserNewsDigest } = require('./buildUserNewsDigest');
const { getAlreadyShownHistoryForUser } = require('./getAlreadyShownUrlsForUser');
const { exclusionsFromItems, mergeExclusions, lockKeyFor } = require('./digestExclusions');
const { startTimer, timeAsync } = require('./timing');

// 💥 CANDADO EN MEMORIA: Evita que el mismo usuario procese dos resúmenes en paralelo
const activeGenerations = new Map();

/**
 * Arma el digest de un usuario.
 *
 * Sin opciones arma el digest completo con los temas del usuario.
 * Con `onlyTopics` arma SOLO esos temas (reposición de notas vencidas, ver staleDigest.js):
 *   - onlyTopics: temas a armar, uno por nota (puede haber repetidos)
 *   - keepItems:  notas del digest que se quedan; ni se repiten ni se trae su misma historia
 */
async function buildDigestForUser(userId, { onlyTopics = null, keepItems = [] } = {}) {
  const userIdStr = String(userId);
  const partial = Array.isArray(onlyTopics);
  const lockKey = lockKeyFor(userId, { onlyTopics, keepItems });

  // Si ya hay una generación corriendo, nos colgamos de esa promesa y evitamos gastar en la API
  if (activeGenerations.has(lockKey)) {
    console.log(`🔒 [LOCK] Esperando generación en curso para user=${userIdStr}...`);
    return activeGenerations.get(lockKey);
  }

  // Envolvemos toda tu lógica original en una Promesa aislada
  const generationPromise = (async () => {
    const totalTimer = startTimer('buildDigestForUser', { userId: userIdStr });

    try {
      const user = await UserPreference.findById(userId).lean();
      if (!user || !user.isActive) throw new Error('User not found or inactive');

      const history = await getAlreadyShownHistoryForUser(user._id);
      const kept = partial && keepItems.length > 0 ? await exclusionsFromItems(keepItems) : null;

      const exclusions = mergeExclusions(
        { urls: history.urls, titles: history.titles, seenEmbeddings: history.seenEmbeddings },
        kept
      );
      const uniqueAlreadyShownUrls = exclusions.urls;
      const uniqueAlreadyShownTitles = exclusions.titles;
      const seenEmbeddings = exclusions.seenEmbeddings;
      const topics = partial ? onlyTopics : (user.topics || []);

      console.log(`🛡️ [FILTRO ANTI-DUPLICADOS] Excluyendo ${uniqueAlreadyShownUrls.length} URLs y evaluando similitud vectorial contra ${seenEmbeddings.length} vectores.`);

      const digest = await timeAsync(
        'buildUserNewsDigest',
        () => buildUserNewsDigest({
          topics,
          alreadyShownUrls: uniqueAlreadyShownUrls,
          alreadyShownTitles: uniqueAlreadyShownTitles,
          seenEmbeddings: seenEmbeddings,
        }),
        {
          userId: String(user._id),
          topics,
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
        motivo: partial ? 'reemplazo_vencidas' : 'refresh_test',
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
          nivel: item.tier || null,
          edadHoras: item.ageHoursAtPick ?? null,
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
  activeGenerations.set(lockKey, generationPromise);

  try {
    return await generationPromise;
  } finally {
    // Liberamos el candado SIEMPRE (incluso si falla)
    activeGenerations.delete(lockKey);
  }
}

module.exports = { buildDigestForUser };
