const fs = require('fs');
const os = require('os');
const path = require('path');

const UserPreference = require('../models/UserPreference');
const UserDeliveryRun = require('../models/UserDeliveryRun');
const { buildUserNewsDigest } = require('./buildUserNewsDigest');
const { getLocalDateString } = require('./dateHelpers');
const { buildDigestAudioScript } = require('../audio/buildDigestAudioScript');
const { generateDigestAudioFile } = require('../audio/generateDigestAudioFile');
const { uploadDigestAudio, deleteDigestAudio } = require('../audio/uploadDigestAudio');
const { startTimer, timeAsync } = require('./timing');

async function buildDigestForUser(userId) {
  const totalTimer = startTimer('buildDigestForUser', {
    userId: String(userId),
  });

  let tempFilePath = null;

  try {
    const user = await UserPreference.findById(userId).lean();

    if (!user) {
      throw new Error('User not found');
    }

    if (!user.isActive) {
      throw new Error('User is inactive');
    }

    const previousRuns = await UserDeliveryRun.find({
      userId: user._id,
      status: { $in: ['prepared', 'sent'] },
      digest: { $ne: null },
    })
      .sort({ preparedAt: -1, createdAt: -1 })
      .limit(10)
      .lean();

    const alreadyShownUrls = previousRuns
      .flatMap((run) => run?.digest?.items || [])
      .map((item) => item?.url)
      .filter(Boolean);

    const digest = await timeAsync(
      'buildUserNewsDigest',
      () =>
        buildUserNewsDigest({
          topics: user.topics || [],
          alreadyShownUrls,
        }),
      {
        userId: String(user._id),
        topics: user.topics || [],
        alreadyShownUrlsCount: alreadyShownUrls.length,
      }
    );

    const today = getLocalDateString(new Date());

    const previousRun = await UserDeliveryRun.findOne({
      userId: user._id,
      status: 'prepared',
      'digest.audioStorageKey': { $exists: true, $ne: null },
    })
      .sort({ preparedAt: -1, createdAt: -1 })
      .lean();

    const script = buildDigestAudioScript({
      userName: user.name,
      items: digest.items || [],
    });

    tempFilePath = path.join(os.tmpdir(), `digest-${user._id}-${Date.now()}.mp3`);
    const storageKey = `digests-audio/${today}/user-${user._id}`;

    await timeAsync(
      'generateDigestAudioFile',
      () =>
        generateDigestAudioFile({
          script,
          outputPath: tempFilePath,
        }),
      {
        userId: String(user._id),
        scriptLength: script.length,
      }
    );

    const { audioUrl, audioStorageKey } = await timeAsync(
      'uploadDigestAudio',
      () => uploadDigestAudio(tempFilePath, storageKey),
      {
        userId: String(user._id),
        storageKey,
      }
    );

    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
      tempFilePath = null;
    }

    if (
      previousRun?.digest?.audioStorageKey &&
      previousRun.digest.audioStorageKey !== audioStorageKey
    ) {
      await deleteDigestAudio(previousRun.digest.audioStorageKey);
    }

    const result = {
      user: {
        id: String(user._id),
        name: user.name,
        deliveryTime: user.deliveryTime,
        topics: user.topics || [],
      },
      digest: {
        items: digest.items || [],
        audioUrl,
        audioStorageKey,
        audioGeneratedAt: new Date().toISOString(),
      },
    };

    totalTimer.end({
      userId: String(user._id),
      items: digest.items?.length || 0,
      hasAudio: Boolean(audioUrl),
    });

    return result;
  } catch (error) {
    totalTimer.fail(error, {
      userId: String(userId),
    });

    throw error;
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
  }
}

module.exports = {
  buildDigestForUser,
};