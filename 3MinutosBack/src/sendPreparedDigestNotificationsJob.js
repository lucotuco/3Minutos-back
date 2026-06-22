const cron = require('node-cron');
const UserDeliveryRun = require('./models/UserDeliveryRun');
const UserPreference = require('./models/UserPreference');
const { sendPushNotification } = require('./utils/sendPushNotification');
const {
  APP_TIME_ZONE,
  getLocalDateString,
  getMinutesNow,
  parseTimeToMinutes,
} = require('./utils/dateHelpers');

let isSendingNotifications = false;

function isRunDue(run, now = new Date()) {
  if (!run?.deliveryDate || !run?.deliveryTime) return false;

  const today = getLocalDateString(now);

  if (run.deliveryDate !== today) {
    return false;
  }

  const deliveryMinutes = parseTimeToMinutes(run.deliveryTime);

  if (deliveryMinutes === null) {
    return false;
  }

  const currentMinutes = getMinutesNow(now);

  return deliveryMinutes <= currentMinutes;
}

async function sendPreparedDigestNotifications({ now = new Date() } = {}) {
  if (isSendingNotifications) {
    console.log('⏭️ Notificaciones omitidas: ya hay una corrida en curso');
    return;
  }

  isSendingNotifications = true;

  try {
    const today = getLocalDateString(now);

    const runs = await UserDeliveryRun.find({
      status: 'prepared',
      notificationSentAt: null,
      deliveryDate: today,
      digest: { $ne: null },
    })
      .sort({ deliveryTime: 1, preparedAt: 1, createdAt: 1 })
      .limit(100);

    const dueRuns = runs.filter((run) => isRunDue(run, now));

    if (!dueRuns.length) {
      console.log('🔕 No hay corridas prepared vencidas para notificar');
      return;
    }

    console.log(`📬 Corridas vencidas para notificación: ${dueRuns.length}`);

    for (const run of dueRuns) {
      try {
        console.log(`\n📦 Procesando run ${run._id}`);
        console.log(`   userId: ${run.userId}`);
        console.log(`   deliveryDate: ${run.deliveryDate}`);
        console.log(`   deliveryTime: ${run.deliveryTime}`);
        console.log(`   notificationSentAt: ${run.notificationSentAt}`);

        const user = await UserPreference.findById(run.userId).lean();

        if (!user) {
          console.log(`⚠️ Usuario no encontrado para run ${run._id}`);
          continue;
        }

        console.log(`   user.name: ${user.name}`);
        console.log(`   user.isActive: ${user.isActive}`);
        console.log(`   expoPushToken: ${user.expoPushToken}`);

        if (!user.isActive) {
          console.log(`⚠️ Usuario inactivo para run ${run._id}`);
          continue;
        }

        if (!user.expoPushToken) {
          console.log(`⚠️ Usuario sin expoPushToken: ${user._id}`);
          continue;
        }

        const itemsCount = Array.isArray(run.digest?.digest?.items)
          ? run.digest.digest.items.length
          : Array.isArray(run.digest?.items)
            ? run.digest.items.length
            : 0;

        const title = 'Tu resumen ya está listo';
        const body =
          itemsCount > 0
            ? `Ya tenés ${itemsCount} noticias nuevas en 3 Minutos.`
            : 'Ya tenés tu nuevo resumen disponible.';

        console.log('   enviando push...');

        const tickets = await sendPushNotification({
          to: user.expoPushToken,
          title,
          body,
          data: {
            type: 'daily_digest',
            runId: String(run._id),
            userId: String(user._id),
            deliveryDate: run.deliveryDate,
            deliveryTime: run.deliveryTime,
          },
        });

        console.log('   tickets Expo:', JSON.stringify(tickets, null, 2));

        run.notificationSentAt = new Date();
        await run.save();

        console.log(`✅ Notificación enviada para run ${run._id}`);
      } catch (error) {
        console.error(`❌ Error enviando notificación para run ${run._id}:`, error.message);
      }
    }
  } catch (error) {
    console.error('❌ Error general en sendPreparedDigestNotifications:', error.message);
  } finally {
    isSendingNotifications = false;
  }
}

function startSendPreparedDigestNotificationsJob() {
  cron.schedule(
    '* * * * *',
    async () => {
      await sendPreparedDigestNotifications();
    },
    {
      timezone: APP_TIME_ZONE,
    }
  );
}

module.exports = {
  startSendPreparedDigestNotificationsJob,
  sendPreparedDigestNotifications,
  isRunDue,
};