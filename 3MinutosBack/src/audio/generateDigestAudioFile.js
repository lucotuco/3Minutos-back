const fs = require('fs');
// Importamos el cliente oficial de Google Cloud TTS
const textToSpeech = require('@google-cloud/text-to-speech');
const { startTimer } = require('../utils/timing');

// Instanciamos el cliente (Google detecta tu .env automáticamente)
const client = new textToSpeech.TextToSpeechClient();

async function generateDigestAudioFile({ script, outputPath }) {
  const timer = startTimer('generateDigestAudioFile TTS', {
    outputPath,
    scriptLength: script?.length || 0,
  });

  try {
    // 1. Configuramos la petición para Google Cloud
    const request = {
      input: { text: script },
      // Voz Neuronal premium Argentina Masculina
      voice: { languageCode: 'es-AR', name: 'es-AR-Neural2-B' },
      // Formato MP3 y la velocidad que tenías (speakingRate en lugar de speed)
      audioConfig: { audioEncoding: 'MP3', speakingRate: 1.15 },
    };

    // 2. Llamamos a la API de Google
    const [response] = await client.synthesizeSpeech(request);

    // 3. Guardamos el archivo MP3 (response.audioContent ya es un buffer binario listo)
    fs.writeFileSync(outputPath, response.audioContent, 'binary');

    // 👇 CÁLCULO DE COSTO PARA GOOGLE CLOUD 👇
    const caracteres = script?.length || 0;
    // La voz premium Neural2 cuesta $0.016 por cada 1000 caracteres
    // (Tenés 1 millón de caracteres gratis al mes para voces Standard, 
    // y para Neural2 los primeros 1 millón también suelen ser gratis).
    const costoPorMilCaracteres = 0.016; 
    const costoTotal = (caracteres / 1000) * costoPorMilCaracteres;

    console.log(`\n🎙️ [CONSUMO AUDIO - GOOGLE TTS]`);
    console.log(`   - Archivo generado: ${outputPath.split('/').pop()}`);
    console.log(`   - Caracteres procesados: ${caracteres}`);
    console.log(`   - Costo exacto de este audio: $${costoTotal.toFixed(5)} USD`);
    console.log(`   - Costo proyectado (30 días sin caché): $${(costoTotal * 30).toFixed(4)} USD al mes\n`);
    // 👆 ==================================== 👆

    timer.end({
      outputPath,
      bytes: response.audioContent.length,
    });

    return outputPath;
  } catch (error) {
    timer.fail(error, {
      outputPath,
    });
    throw error;
  }
}

module.exports = {
  generateDigestAudioFile,
};