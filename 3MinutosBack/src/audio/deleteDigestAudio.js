const cloudinary = require('../config/cloudinary');

async function deleteDigestAudio(audioStorageKey) {
  if (!audioStorageKey) return;

  try {
    await cloudinary.uploader.destroy(audioStorageKey, {
      resource_type: 'video',
      invalidate: true,
    });
  } catch (error) {
    console.error('Error borrando audio en Cloudinary:', error.message);
  }
}

module.exports = { deleteDigestAudio };