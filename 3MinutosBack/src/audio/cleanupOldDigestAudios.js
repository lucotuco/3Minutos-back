const cloudinary = require('../config/cloudinary');
const Article = require('../models/Article');

// Los audios de notas se borran a las 72 h: ninguna nota se entrega con más de 24 h (staleDigest.js).
const MAX_AGE_HOURS = 72;
const PREFIX = 'articles-chunks/';
const PAGE_SIZE = 500;
const MAX_PAGES = 50; // tope de seguridad: 25.000 audios por corrida

/** El id de la nota a partir del public_id del audio ("articles-chunks/audio-<id>"), o null. */
function articleIdFromPublicId(publicId = '') {
  const match = String(publicId).match(/audio-([a-f0-9]{24})$/i);
  return match ? match[1] : null;
}

/** Los audios de la página que tienen más de `maxAgeHours`. */
function selectOldResources(resources = [], { now = Date.now(), maxAgeHours = MAX_AGE_HOURS } = {}) {
  return resources.filter((file) => {
    const createdAt = new Date(file.created_at).getTime();
    if (!Number.isFinite(createdAt)) return false;
    return (now - createdAt) / 3600e3 > maxAgeHours;
  });
}

/**
 * Borra de Cloudinary los audios de notas con más de 72 h y le saca el audioUrl a la nota, así /play no
 * devuelve un enlace a un archivo que ya no existe. Recorre todas las páginas, no solo las primeras 500.
 *
 * `deps` solo se usa en los tests.
 */
async function cleanupOldDigestAudios({ now = Date.now(), deps = {} } = {}) {
  const api = deps.cloudinary || cloudinary;
  const articles = deps.Article || Article;
  const stats = { revisados: 0, borrados: 0, errores: 0 };

  try {
    let cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await api.api.resources({
        type: 'upload',
        resource_type: 'video',
        prefix: PREFIX,
        max_results: PAGE_SIZE,
        ...(cursor ? { next_cursor: cursor } : {}),
      });

      const resources = result?.resources || [];
      stats.revisados += resources.length;

      for (const file of selectOldResources(resources, { now })) {
        try {
          await api.uploader.destroy(file.public_id, { resource_type: 'video', invalidate: true });
          stats.borrados++;
          const articleId = articleIdFromPublicId(file.public_id);
          if (articleId) {
            await articles.updateOne({ _id: articleId }, { $set: { audioUrl: null } });
          }
        } catch (error) {
          stats.errores++;
          console.error(`Error borrando ${file.public_id}:`, error.message);
        }
      }

      cursor = result?.next_cursor;
      if (!cursor) break;
    }

    console.log(
      `🧹 Audios de notas: ${stats.revisados} revisados, ${stats.borrados} borrados (más de ${MAX_AGE_HOURS} h), ${stats.errores} errores.`
    );
  } catch (error) {
    console.error('Error limpiando audios viejos:', error.message);
  }

  return stats;
}

module.exports = { cleanupOldDigestAudios, selectOldResources, articleIdFromPublicId };
