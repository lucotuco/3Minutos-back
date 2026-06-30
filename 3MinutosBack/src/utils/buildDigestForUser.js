const UserPreference = require('../models/UserPreference');
const UserDeliveryRun = require('../models/UserDeliveryRun');
const { buildUserNewsDigest } = require('./buildUserNewsDigest');
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

    const previousRuns = await UserDeliveryRun.find({
      userId: user._id,
      status: { $in: ['prepared', 'sent'] },
      digest: { $ne: null },
    })
      .sort({ preparedAt: -1, createdAt: -1 })
      .limit(10)
      .lean();

    const alreadyShownUrls = previousRuns
      .flatMap((run) => getDigestItemsFromRun(run))
      .map((item) => item?.url)
      .filter(Boolean);

    const uniqueAlreadyShownUrls = [...new Set(alreadyShownUrls)];

    const digest = await timeAsync(
      'buildUserNewsDigest',
      () => buildUserNewsDigest({
        topics: user.topics || [],
        alreadyShownUrls: uniqueAlreadyShownUrls,
      }),
      {
        userId: String(user._id),
        topics: user.topics || [],
        alreadyShownUrlsCount: uniqueAlreadyShownUrls.length,
      }
    );

    // Armamos la respuesta idéntica pero con propiedades de audio vacías/null.
    // El audio se procesará únicamente cuando toquen "Play".
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