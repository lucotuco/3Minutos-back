const mongoose = require('mongoose');
const Article = require('../models/Article');
const GlobalContext = require('../models/GlobalContext');
const { openaiReview, OPENAI_MODEL } = require('../config/openai');
require('dotenv').config();
async function generateDailyContext() {
  try {
    // 0. Conectamos a MongoDB Atlas si no estamos conectados
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI);
      console.log('🔌 Conectado a MongoDB Atlas...');
    }

    // 1. EL OJEADOR PREMIUM: Buscamos noticias de alto impacto de las últimas 12 horas
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
    
    const recentArticles = await Article.find({ 
        publishedAt: { $gte: twelveHoursAgo },
        importanceScore: { $gte: 75 } // Solo lo realmente relevante
      })
      .sort({ importanceScore: -1 }) 
      .limit(50) 
      .select('title category')
      .lean();

    if (recentArticles.length === 0) {
      console.log('⚠️ No hay noticias suficientes (>= 75 puntos) en las últimas 12 horas.');
      return;
    }

    console.log(`🧠 Leyendo ${recentArticles.length} titulares de alto impacto para sintetizar la realidad...`);
    const headlines = recentArticles.map(a => `- [${a.category}] ${a.title}`).join('\n');

    // 2. LA SÍNTESIS: Le pedimos a la IA que entienda el mundo hoy
    const response = await openaiReview.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Sos un analista de noticias. Tu tarea es leer una lista de titulares recientes y escribir un único párrafo (máximo 5 renglones) resumiendo los resultados de los eventos más importantes. Sé estrictamente factual (ej: 'El equipo X le ganó al equipo Y', 'El dólar cerró a X')."
        },
        {
          role: "user",
          content: `Titulares de las últimas 12 horas:\n\n${headlines}`
        }
      ]
    });

    const contextSummary = response.choices[0].message.content.trim();

    // 3. GUARDAMOS EL CEREBRO EN MONGODB
    await GlobalContext.create({ summary: contextSummary });
    
    console.log('\n✅ Nuevo Contexto Global generado y guardado con éxito:');
    console.log('---------------------------------------------------------');
    console.log(contextSummary);
    console.log('---------------------------------------------------------');

  } catch (error) {
    console.error('❌ Error generando contexto:', error);
  } finally {
    // Si corremos este archivo desde la terminal, cerramos la conexión al terminar
    if (require.main === module) {
      await mongoose.disconnect();
      console.log('🔌 Desconectado de MongoDB.');
      process.exit(0);
    }
  }
}

// 🔥 EL DETALLE CLAVE: Si ejecutamos "node generateDailyContext.js", se dispara solo
if (require.main === module) {
  generateDailyContext();
}

module.exports = { generateDailyContext };