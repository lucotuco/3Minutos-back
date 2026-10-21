const mongoose = require('mongoose');

/**
 * Copia de las expansiones de los temas libres (utils/topicExpansion.js) para que un reinicio o un deploy del servidor
 * no vuelva a pagar la llamada a la IA por cada tema que ya se había expandido. La escribe y la lee solo el servidor
 * (utils/topicExpansionStore.js); las herramientas de prueba no la tocan.
 *
 * `key` es un hash del modelo, la semilla, el prompt de ese año (con la taxonomía de temas oficiales) y el tema:
 * si cambia cualquiera de ellos la clave es otra y la copia vieja deja de usarse sola. Para forzar que todos los temas
 * se vuelvan a expandir basta con vaciar la colección.
 *
 * RETENTION_SECONDS es solo la limpieza de la colección (índice TTL de Mongo, que borra con algo de demora). Lo que el
 * motor da por bueno es menos: STORE_TTL_MS en el módulo del almacén, que revisa la edad en cada lectura.
 */
const RETENTION_SECONDS = 30 * 24 * 3600;

const TopicExpansionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    topic: { type: String, required: true }, // el tema normalizado ("river plate"): solo para mirar la colección a ojo
    q: { type: String, required: true },
    cat: { type: String, default: '' },
    sub: { type: String, default: '' },
    model: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now, expires: RETENTION_SECONDS },
  },
  { versionKey: false },
);

const TopicExpansion = mongoose.model('TopicExpansion', TopicExpansionSchema, 'topic_expansions');
TopicExpansion.RETENTION_SECONDS = RETENTION_SECONDS;

module.exports = TopicExpansion;
