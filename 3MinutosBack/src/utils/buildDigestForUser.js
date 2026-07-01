const UserPreference = require('../models/UserPreference');
const UserDeliveryRun = require('../models/UserDeliveryRun');

const { buildUserNewsDigest } = require('./buildUserNewsDigest');
// 👇 IMPORTAMOS LA UTILIDAD DE HISTORIAL ABSOLUTO QUE NO SE ESTABA USANDO
const { getAlreadyShownHistoryForUser } = require('./getAlreadyShownUrlsForUser');
const { startTimer, timeAsync } = require('./timing');

function getDigestItemsFromRun(run) {
  if (Array.isArray(run?.digest?.digest?.items)) return run.digest.digest.items;
  if (Array.isArray(run?.digest?.items)) return run.digest.items;
  return [];
}

async function buildDigestForUser(userId) {
  const totalTimer = startTimer('buildDigestForUser', { userId: String(userId) });

  try {
    const user = await UserPreference.findById(userId).lean();
    if (!user || !user.isActive) throw new Error('User not found or inactive');

   // 1. Buscamos el historial definitivo directamente de la base de datos
    const history = await getAlreadyShownHistoryForUser(user._id);

    // 2. Extraemos URLs y Títulos únicos
    const uniqueAlreadyShownUrls = [...new Set(history.urls)];
    const uniqueAlreadyShownTitles = [...new Set(history.titles)];

    console.log(`🛡️ [FILTRO ANTI-DUPLICADOS] Excluyendo ${uniqueAlreadyShownUrls.length} URLs y evaluando similitud contra ${uniqueAlreadyShownTitles.length} títulos.`);

    // 3. Generamos el Digest (Asegurate de que se llame buildUserNewsDigest)
    const digest = await timeAsync(
      'buildUserNewsDigest',
      () => buildUserNewsDigest({
        topics: user.topics || [],
        alreadyShownUrls: uniqueAlreadyShownUrls,
        alreadyShownTitles: uniqueAlreadyShownTitles, // <-- PASAMOS LOS TÍTULOS
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

    totalTimer.end({
      userId: String(user._id),
      items: digest.items?.length || 0,
      hasAudio: false,
    });

    return result;
  } catch (error) {
    totalTimer.fail(error, { userId: String(userId) });
    throw error;
  }
}

module.exports = { buildDigestForUser };