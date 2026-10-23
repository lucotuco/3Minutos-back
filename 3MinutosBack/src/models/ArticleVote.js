const mongoose = require('mongoose');

/**
 * ArticleVote
 *
 * El pulgar arriba / abajo que el usuario le da a una nota de su digest, GUARDADO JUNTO AL CONTEXTO DE LA DECISIÓN
 * que tomó el motor (edad, importancia, puntaje, zona, si fue rescate...). Sin ese contexto un pulgar abajo solo
 * dice "algo estuvo mal"; con él se puede preguntar "¿los pulgares abajo caen en las notas viejas? ¿en los
 * rescates? ¿en importancia baja?", que es lo que indica qué regla del motor cambiar.
 *
 * El contexto lo completa el SERVIDOR leyendo la corrida que él mismo guardó (utils/voteContext.js): el cliente
 * manda solo articleId, vote y reason, así no puede ensuciar los datos ni necesita conocer el motor.
 *
 * Un voto por usuario y nota (índice único): votar de nuevo CAMBIA el voto, no suma otro.
 */

const VOTE_UP = 1;
const VOTE_DOWN = -1;
const VOTE_VALUES = [VOTE_UP, VOTE_DOWN];

// Motivos del pulgar ABAJO. Cada uno apunta a una parte distinta del sistema:
//   aburrida        -> la importancia no mide interés (candidato a un juez de interés)
//   no_es_del_tema  -> el juez de tema fue permisivo, o se quedó sin presupuesto
//   ya_la_sabia     -> falló el control de misma historia o el historial
//   vieja           -> hay que subir el peso de la frescura
// El pulgar ARRIBA no lleva motivo a propósito: preguntarle el por qué a quien vota bien baja la cantidad de votos.
const DOWN_REASONS = ['aburrida', 'no_es_del_tema', 'ya_la_sabia', 'vieja'];

// De dónde salió el contexto. 'sin_contexto' no es un error: el voto puede llegar cuando la nota ya no está en el
// digest (se refrescó, la reemplazó staleDigest, o votó días después). El voto se guarda igual; lo que se pierde
// es poder cruzarlo con la decisión.
const CONTEXT_SOURCES = ['corrida', 'sin_contexto'];

const ArticleVoteSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'UserPreference',
      required: true,
      index: true,
    },
    articleId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    articleUrl: {
      type: String,
      default: null,
    },
    vote: {
      type: Number,
      enum: VOTE_VALUES,
      required: true,
    },
    reason: {
      type: String,
      enum: [...DOWN_REASONS, null],
      default: null,
    },

    // ---------------------------------------------------------------- contexto de la decisión del motor
    topic: { type: String, default: null },            // el tópico del usuario para el que se eligió
    zona: { type: String, default: null },              // ETIQUETA | VERDE | AMARILLA | RESCATE
    nivel: { type: String, default: null },             // buena | aceptable | sugerida
    edadHoras: { type: Number, default: null },         // edad de la nota cuando se eligió
    importancia: { type: Number, default: null },       // importanceScore
    puntaje: { type: Number, default: null },           // deliveryScore con que ganó (temas oficiales)
    candidatosEvaluados: { type: Number, default: null },
    usedFallback: { type: Boolean, default: null },     // true = rescate (nota "sugerida" de otro subtema)
    publishedAt: { type: Date, default: null },
    deliveryDate: { type: String, default: null },      // la fecha local del digest donde salió la nota
    contextSource: {
      type: String,
      enum: CONTEXT_SOURCES,
      default: 'sin_contexto',
    },
  },
  { timestamps: true }
);

// Un voto por usuario y nota: el segundo voto actualiza el primero.
ArticleVoteSchema.index({ userId: 1, articleId: 1 }, { unique: true });

// Para las consultas de análisis ("los pulgares abajo de los últimos 7 días").
ArticleVoteSchema.index({ createdAt: -1 });

const ArticleVote = mongoose.model('ArticleVote', ArticleVoteSchema, 'article_votes');

module.exports = ArticleVote;
module.exports.VOTE_UP = VOTE_UP;
module.exports.VOTE_DOWN = VOTE_DOWN;
module.exports.VOTE_VALUES = VOTE_VALUES;
module.exports.DOWN_REASONS = DOWN_REASONS;
module.exports.CONTEXT_SOURCES = CONTEXT_SOURCES;
