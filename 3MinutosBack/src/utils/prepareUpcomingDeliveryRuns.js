const UserPreference = require('../models/UserPreference');
const UserDeliveryRun = require('../models/UserDeliveryRun');
const { buildDigestForUser } = require('./buildDigestForUser');

const {
  getLocalDateString,
  parseTimeToMinutes,
  getMinutesNow,
} = require('../utils/dateHelpers');

function isMinutesInWindow(deliveryMinutes, nowMinutes, minutesAhead) {
  if (deliveryMinutes === null) return false;

  const endMinutes = (nowMinutes + minutesAhead) % 1440;

  if (nowMinutes <= endMinutes) {
    return deliveryMinutes >= nowMinutes && deliveryMinutes <= endMinutes;
  }

  return deliveryMinutes >= nowMinutes || deliveryMinutes <= endMinutes;
}

async function prepareUpcomingDeliveryRuns({
  minutesAhead = 15,
  now = new Date(),
} = {}) {
  const users = await UserPreference.find({
    isActive: true,
  }).lean();

  const nowMinutes = getMinutesNow(now);
  const deliveryDate = getLocalDateString(now);

  const usersInWindow = users.filter((user) => {
    const deliveryMinutes = parseTimeToMinutes(user.deliveryTime);
    return isMinutesInWindow(deliveryMinutes, nowMinutes, minutesAhead);
  });

  const results = [];

  for (const user of usersInWindow) {
    let run;
    let deliveryRun;

    try {
      run = await UserDeliveryRun.findOneAndUpdate(
        {
          userId: user._id,
          deliveryDate,
          deliveryTime: user.deliveryTime,
        },
        {
          $setOnInsert: {
            userId: user._id,
            deliveryDate,
            deliveryTime: user.deliveryTime,
            status: 'preparing',
            preferencesSnapshot: {
              topics: user.topics || [],
              deliveryTime: user.deliveryTime,
            },
          },
        },
        {
          upsert: true,
          returnDocument: 'after',
          includeResultMetadata: true,
          setDefaultsOnInsert: true,
        }
      );

      deliveryRun = run?.value;

      if (!deliveryRun) {
        throw new Error(
          `findOneAndUpdate no devolvió deliveryRun. run=${JSON.stringify(run)}`
        );
      }

      const wasCreated = Boolean(run.lastErrorObject?.upserted);

      if (!wasCreated) {
        results.push({
          userId: String(user._id),
          name: user.name,
          deliveryTime: user.deliveryTime,
          created: false,
          status: deliveryRun.status,
          runId: String(deliveryRun._id),
        });

        continue;
      }

      const digest = await buildDigestForUser(user._id);

      const updatedRun = await UserDeliveryRun.findByIdAndUpdate(
        deliveryRun._id,
        {
          $set: {
            status: 'prepared',
            digest,
            preparedAt: new Date(),
            errorMessage: '',
          },
        },
        {
          returnDocument: 'after',
        }
      );

      if (!updatedRun) {
        throw new Error(
          `No se pudo actualizar UserDeliveryRun con id=${String(deliveryRun._id)}`
        );
      }

      results.push({
        userId: String(user._id),
        name: user.name,
        deliveryTime: user.deliveryTime,
        created: true,
        status: updatedRun.status,
        runId: String(updatedRun._id),
      });
    } catch (error) {
      const errorMessage = error.message || 'Unknown prepare error';

      if (deliveryRun?._id) {
        const erroredRun = await UserDeliveryRun.findByIdAndUpdate(
          deliveryRun._id,
          {
            $set: {
              status: 'error',
              errorMessage,
            },
          },
          {
            returnDocument: 'after',
          }
        );

        results.push({
          userId: String(user._id),
          name: user.name,
          deliveryTime: user.deliveryTime,
          created: false,
          status: erroredRun?.status || 'error',
          runId: erroredRun?._id ? String(erroredRun._id) : String(deliveryRun._id),
          errorMessage: erroredRun?.errorMessage || errorMessage,
        });

        continue;
      }

      results.push({
        userId: String(user._id),
        name: user.name,
        deliveryTime: user.deliveryTime,
        created: false,
        status: 'error',
        errorMessage,
      });
    }
  }

  return results;
}

module.exports = {
  prepareUpcomingDeliveryRuns,
};