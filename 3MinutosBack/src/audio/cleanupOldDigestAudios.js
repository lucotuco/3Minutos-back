const { cloudinary } = require('../config/cloudinary');

async function cleanupOldDigestAudios() {
  try {
    // Le decimos a Cloudinary que busque en la nueva carpeta de noticias
    const result = await cloudinary.api.resources({
      type: 'upload',
      resource_type: 'video',
      prefix: 'articles-chunks/', // Carpeta nueva de audios separados
      max_results: 500,
    });

    const now = new Date();

    // Filtramos los que tengan más de 72 horas (3 días) de creados
    const oldResources = (result.resources || []).filter((file) => {
      const createdAt = new Date(file.created_at);
      const diffHours = (now - createdAt) / (1000 * 60 * 60);
      return diffHours > 72; // Si tiene más de 72 horas de vida, es basura
    });

    console.log(`🧹 Se encontraron ${oldResources.length} audios de noticias caducados para borrar.`);

    for (const file of oldResources) {
      try {
        await cloudinary.uploader.destroy(file.public_id, {
          resource_type: 'video',
          invalidate: true,
        });
      } catch (error) {
        console.error(`Error borrando ${file.public_id}:`, error.message);
      }
    }
  } catch (error) {
    console.error('Error limpiando audios viejos:', error.message);
  }
}

module.exports = { cleanupOldDigestAudios };