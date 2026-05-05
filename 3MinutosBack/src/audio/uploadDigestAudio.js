const cloudinary = require('../config/cloudinary');
const { startTimer } = require('../utils/timing');

async function uploadDigestAudio(filePath, storageKey) {
  const timer = startTimer('uploadDigestAudio Cloudinary', {
    filePath,
    storageKey,
  });

  try {
    const result = await cloudinary.uploader.upload(filePath, {
      resource_type: 'video',
      public_id: storageKey,
      overwrite: true,
    });

    timer.end({
      audioUrl: result.secure_url,
      audioStorageKey: result.public_id,
    });

    return {
      audioUrl: result.secure_url,
      audioStorageKey: result.public_id,
    };
  } catch (error) {
    timer.fail(error, {
      filePath,
      storageKey,
    });

    throw error;
  }
}

async function deleteDigestAudio(audioStorageKey) {
  if (!audioStorageKey) {
    return null;
  }

  return cloudinary.uploader.destroy(audioStorageKey, {
    resource_type: 'video',
  });
}

module.exports = {
  uploadDigestAudio,
  deleteDigestAudio,
};