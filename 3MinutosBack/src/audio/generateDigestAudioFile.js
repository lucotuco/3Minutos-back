const fs = require('fs');

const { openai } = require('../config/openai');
const { startTimer } = require('../utils/timing');

async function generateDigestAudioFile({ script, outputPath }) {
  const timer = startTimer('generateDigestAudioFile TTS', {
    outputPath,
    scriptLength: script?.length || 0,
  });

  try {
    // 1. Ajustamos el prompt para pedirle un ritmo más ágil y dinámico
    const DIGEST_VOICE_STYLE =
      process.env.DIGEST_VOICE_STYLE ||
      [
        'Actuá como un presentador de noticias de una app moderna. Tu tono debe ser directo, seguro y con mucha presencia.',
        'Usá español rioplatense con voseo de forma natural y fluida.',
        'Alejate del tono dramático o exagerado de la televisión; mantené la sobriedad pero con frescura.',
        'Hablá con ritmo ágil y frases cortas, usando inflexiones en la voz para mantener la atención del oyente.',
        'Hacé una pausa clara de un segundo al terminar cada noticia.'
      ].join(' ');

    const response = await openai.audio.speech.create({
      model: process.env.OPENAI_TTS_MODEL || 'tts-1',
      voice: 'echo',
      input: script,
      instructions: DIGEST_VOICE_STYLE,
      format: 'mp3',
      // 3. Agregamos el parámetro speed. 1.0 es el default. 1.15 o 1.2 suele ser ideal para noticias.
      speed: 1.15,
    });

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    fs.writeFileSync(outputPath, buffer);

    timer.end({
      outputPath,
      bytes: buffer.length,
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