const mongoose = require('mongoose');

const DigestTestLogSchema = new mongoose.Schema(
  {
    idUsuario: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'UserPreference',
      required: true,
      index: true,
    },
    motivo: {
      type: String,
      default: 'refresh', // Puedes usar 'refresh', 'cron', etc.
    },
    noticias: [
      {
        topicoUsuario: { type: String, default: '' },
        queryExpanded: { type: String, default: null },
        titulo: { type: String, default: '' },
        summaryLead: { type: String, default: '' },
        summary: { type: String, default: '' },
        publishedAt: { type: Date, default: null },
        categoria: { type: String, default: '' },
        puntajeNoticia: { type: Number, default: 0 },
        // Trazabilidad de la busqueda (para medir calidad sin adivinar)
        usedFallback: { type: Boolean, default: false },
        fallbackCategory: { type: String, default: null },
        zona: { type: String, default: null },            // VERDE | AMARILLA | RESCATE | null (sin noticia)
        scoreBusqueda: { type: Number, default: null },   // score hibrido normalizado 0-1
        motivoMatch: { type: String, default: null },
        corralCategoria: { type: String, default: null }, // categoria oficial o inferida por voto
        candidatosEvaluados: { type: Number, default: 0 },
      }
    ],
  },
  { timestamps: true } // Agrega createdAt y updatedAt automáticamente
);

// Índice para poder filtrar y limpiar logs fácilmente por fecha
DigestTestLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('DigestTestLog', DigestTestLogSchema, 'digest_test_logs');