const cron = require('node-cron');
const { Expo } = require('expo-server-sdk');
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

// Cuántas veces se reintenta un push que falló (Expo caído, red) antes de dar la corrida por perdida.
// El job corre cada minuto: son ~5 minutos de reintentos.
const MAX_NOTIFICATION_ATTEMPTS = 5;

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

/**
 * Por qué no se le puede mandar el push a este usuario, o null si se puede.
 * Una corrida con motivo se marca como salteada y no se vuelve a mirar: antes se quedaba en la cola para
 * siempre y ocupaba lugar en el limit(100) de cada minuto.
 */
function skipReasonFor(user) {
  if (!user) return 'usuario_inexistente';
  if (!user.isActive) return 'usuario_inactivo';
  if (!user.expoPushToken) return 'sin_push_token';
  if (!Expo.isExpoPushToken(user.expoPushToken)) return 'push_token_invalido';
  return null;
}

/** El ticket de Expo dice que el token ya no sirve (la app se desinstaló o el token se renovó). */
function isDeadTokenTicket(ticket) {
  return ticket?.status === 'error' && ticket?.details?.error === 'DeviceNotRegistered';
}

function itemsCountOf(run) {
  if (Array.isArray(run.digest?.digest?.items)) return run.digest.digest.items.length;
  if (Array.isArray(run.digest?.items)) return run.digest.items.length;
  return 0;
}

async function markSkipped(run, reason) {
  await UserDeliveryRun.updateOne(
    { _id: run._id },
    { $set: { notificationSkippedAt: new Date(), notificationSkipReason: reason } }
  );
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
      notificationSkippedAt: null,
      deliveryDate: today,
      digest: { $ne: null },
    })
      .sort({ deliveryTime: 1, preparedAt: 1, createdAt: 1 })
      .limit(100);

    const dueRuns = runs.filter((run) => isRunDue(run, now));

    if (!dueRuns.length) {
      return;
    }

    console.log(`📬 Corridas vencidas para notificación: ${dueRuns.length}`);

    for (const run of dueRuns) {
      try {
        const user = await UserPreference.findById(run.userId).lean();
        const reason = skipReasonFor(user);

        if (reason) {
          await markSkipped(run, reason);
          console.log(`⏭️ Push salteado run=${run._id} user=${run.userId}: ${reason}`);
          continue;
        }

        const itemsCount = itemsCountOf(run);
        const title = 'Tu resumen ya está listo';
        const body =
          itemsCount > 0
            ? `Ya tenés ${itemsCount} noticias nuevas en 3 Minutos.`
            : 'Ya tenés tu nuevo resumen disponible.';

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

        run.notificationSentAt = new Date();
        await run.save();

        if (tickets.some(isDeadTokenTicket)) {
          // Solo se borra si sigue siendo el mismo token: la app pudo haber mandado uno nuevo mientras tanto.
          await UserPreference.updateOne(
            { _id: user._id, expoPushToken: user.expoPushToken },
            { $set: { expoPushToken: null } }
          );
          console.log(`🔕 Token de push dado de baja por Expo, se borra: user=${user._id}`);
        }
      } catch (error) {
        console.error(`❌ Error enviando notificación para run ${run._id}:`, error.message);

        const attempts = Number(run.notificationAttempts || 0) + 1;
        const update = { $set: { notificationAttempts: attempts } };
        if (attempts >= MAX_NOTIFICATION_ATTEMPTS) {
          update.$set.notificationSkippedAt = new Date();
          update.$set.notificationSkipReason = `fallo_envio: ${String(error.message || '').slice(0, 200)}`;
        }
        await UserDeliveryRun.updateOne({ _id: run._id }, update).catch((saveError) => {
          console.error(`❌ No se pudo registrar el intento de notificación (run ${run._id}):`, saveError.message);
        });
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
  skipReasonFor,
  isDeadTokenTicket,
  MAX_NOTIFICATION_ATTEMPTS,
};
