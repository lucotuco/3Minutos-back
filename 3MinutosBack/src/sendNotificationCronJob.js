const cron = require('node-cron');

const { sendPreparedDigestNotifications } = require('./sendPreparedDigestNotificationsJob');
const {
  APP_TIME_ZONE,
  getLocalDateString,
  getMinutesNow,
} = require('./utils/dateHelpers');

let isNotificationJobRunning = false;

function formatArgentinaDateTime(date = new Date()) {
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: APP_TIME_ZONE,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
}

function formatArgentinaHour(date = new Date()) {
  const totalMinutes = getMinutesNow(date);
  const hours = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
  const minutes = String(totalMinutes % 60).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function startNotificationJob() {
  cron.schedule(
    '* * * * *',
    async () => {
      if (isNotificationJobRunning) {
        console.log('⏭️ Job de notificaciones omitido: corrida previa en curso');
        return;
      }

      isNotificationJobRunning = true;

      try {
        const now = new Date();

        //console.log(`\n🔔 Ejecutando job de notificaciones (AR): ${formatArgentinaDateTime(now)}`);
        //console.log(`🗓 Fecha AR: ${getLocalDateString(now)}`);
        //console.log(`🕒 Hora AR: ${formatArgentinaHour(now)}`);

        await sendPreparedDigestNotifications({ now });
      } catch (error) {
        console.error('❌ Error en notification job:', error.message);
      } finally {
        isNotificationJobRunning = false;
      }
    },
    {
      timezone: APP_TIME_ZONE,
    }
  );
}

module.exports = {
  startNotificationJob,
};