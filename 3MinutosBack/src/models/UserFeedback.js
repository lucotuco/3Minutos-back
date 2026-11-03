const mongoose = require('mongoose');

/**
 * UserFeedback
 *
 * La encuesta semanal de la app: "¿Cómo estuvo tu resumen de hoy?" con tres caras y un comentario opcional.
 * La app la muestra al final del digest como mucho una vez por semana (la frecuencia la decide el cliente).
 *
 * Igual que el voto, se guarda junto a lo que el usuario estaba mirando: las notas del digest de ese día con la
 * decisión del motor (tema, zona, nivel, edad, si fue rescate). Así una cara triste se puede cruzar con "ese día le
 * tocaron dos rescates" en vez de quedar como una opinión suelta. Esas notas las completa el servidor desde la
 * corrida guardada; el cliente manda solo la cara y el texto.
 *
 * Una respuesta por usuario y día: responder de nuevo el mismo día la cambia, no suma otra.
 */

// 1 = 😕 flojo, 2 = 🙂 bien, 3 = 😍 muy bien
const FEEDBACK_RATINGS = [1, 2, 3];
const FEEDBACK_COMMENT_MAX = 500;

const NotaDelDigestSchema = new mongoose.Schema(
  {
    articleId: { type: mongoose.Schema.Types.ObjectId, default: null },
    topic: { type: String, default: null },
    zona: { type: String, default: null },
    nivel: { type: String, default: null },
    edadHoras: { type: Number, default: null },
    usedFallback: { type: Boolean, default: null },
  },
  { _id: false }
);

const UserFeedbackSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'UserPreference',
      required: true,
      index: true,
    },
    // Fecha local (AR) en que respondió: con el usuario forma la clave de "una respuesta por día".
    responseDate: { type: String, required: true },
    rating: { type: Number, enum: FEEDBACK_RATINGS, required: true },
    comment: { type: String, default: '', maxlength: FEEDBACK_COMMENT_MAX },

    // ---------------------------------------------------------------- lo que estaba mirando (lo completa el servidor)
    topics: { type: [String], default: [] },
    deliveryDate: { type: String, default: null },   // la fecha del digest que había leído
    notas: { type: [NotaDelDigestSchema], default: [] },
  },
  { timestamps: true }
);

UserFeedbackSchema.index({ userId: 1, responseDate: 1 }, { unique: true });
UserFeedbackSchema.index({ createdAt: -1 });

const UserFeedback = mongoose.model('UserFeedback', UserFeedbackSchema, 'user_feedback');

module.exports = UserFeedback;
module.exports.FEEDBACK_RATINGS = FEEDBACK_RATINGS;
module.exports.FEEDBACK_COMMENT_MAX = FEEDBACK_COMMENT_MAX;
