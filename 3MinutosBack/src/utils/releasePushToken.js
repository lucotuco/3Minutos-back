'use strict';

/**
 * Un celular tiene UN token de notificaciones (Expo). Si dos cuentas lo tienen guardado, ese celular recibe las
 * notificaciones de las dos: le llegaba el aviso de una cuenta vieja que ya no usa (con otro horario) y, al abrir la
 * app, veía el digest de la cuenta actual, que todavía no estaba listo. Caso real: Naty F, dos cuentas con el mismo
 * token, notificaciones a las 9:55 y a las 10:50 durante meses.
 *
 * Cuando una cuenta guarda un token, se lo saca a cualquier otra cuenta que lo tenga: la última que lo registró es
 * la que está usando ese celular. Las otras cuentas no se tocan en nada más.
 *
 * @param {object} UserPreference  el modelo (se recibe para poder probarlo sin Mongo)
 * @param {string} token           el token que se acaba de guardar
 * @param {*}      ownerId         la cuenta que lo guardó
 * @returns {Promise<number>}      cuántas cuentas lo perdieron
 */
async function releasePushTokenFromOtherUsers(UserPreference, token, ownerId) {
  if (!token || !ownerId) return 0;
  try {
    const result = await UserPreference.updateMany(
      { expoPushToken: token, _id: { $ne: ownerId } },
      { $set: { expoPushToken: null } }
    );
    const released = result?.modifiedCount ?? 0;
    if (released > 0) {
      console.log(`[push-token] el token de user=${String(ownerId)} se sacó de ${released} cuenta(s) más`);
    }
    return released;
  } catch (error) {
    // No frena el guardado: lo peor que pasa es que el celular siga recibiendo dos avisos.
    console.error('[push-token] no se pudo sacar el token de otras cuentas:', error.message);
    return 0;
  }
}

/**
 * Limpia los tokens que YA están repetidos (los que quedaron de antes de releasePushTokenFromOtherUsers): por cada
 * token que tienen dos o más cuentas, se lo queda la que se actualizó por última vez (la que usa la app hoy) y a las
 * demás se les saca. Se corre al arrancar el servidor; si no hay repetidos no cambia nada, así que correrlo de nuevo
 * es inofensivo.
 *
 * @param {object} UserPreference  el modelo (se recibe para poder probarlo sin Mongo)
 * @returns {Promise<{tokens:number, released:number}>}  tokens repetidos encontrados y cuentas que perdieron el token
 */
async function releaseDuplicatedPushTokens(UserPreference) {
  const repeated = await UserPreference.aggregate([
    { $match: { expoPushToken: { $type: 'string', $ne: '' } } },
    { $sort: { updatedAt: -1, _id: -1 } },
    { $group: { _id: '$expoPushToken', owners: { $push: '$_id' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);

  let released = 0;
  for (const { _id: token, owners } of repeated) {
    released += await releasePushTokenFromOtherUsers(UserPreference, token, owners[0]);
  }
  if (repeated.length) {
    console.log(`[push-token] tokens repetidos: ${repeated.length}, cuentas que perdieron el token: ${released}`);
  }
  return { tokens: repeated.length, released };
}

module.exports = { releasePushTokenFromOtherUsers, releaseDuplicatedPushTokens };
