const cron = require('node-cron');
const { cleanupOldDigestAudios } = require('./audio/cleanupOldDigestAudios');
const { getLocalDateString, APP_TIME_ZONE } = require('./utils/dateHelpers');

let isCleanupRunning = false;

function startCleanupAudiosJob() {
  // Se ejecuta todos los días a las 03:00 AM (hora Argentina)
  cron.schedule(
    '0 3 * * *',
    async () => {
      if (isCleanupRunning) return;
      isCleanupRunning = true;

      try {
        const todayFolder = getLocalDateString(new Date());
        console.log(`\n🧹 [CRON] Iniciando limpieza de audios viejos en Cloudinary... (Excluyendo carpeta: ${todayFolder})`);
        
        await cleanupOldDigestAudios({ todayFolder });
        
        console.log('✅ [CRON] Limpieza de audios finalizada');
      } catch (error) {
        console.error('❌ [CRON] Error en limpieza de audios:', error.message);
      } finally {
        isCleanupRunning = false;
      }
    },
    {
      timezone: APP_TIME_ZONE,
    }
  );
}

module.exports = {
  startCleanupAudiosJob,
};