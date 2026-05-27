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
        'Narrá como hombre de mediana edad con tono grave.',
        'Tono cálido, cercano, seguro y natural.',
        'Usá español rioplatense con voseo cuando corresponda.',
        'No suenes como locutor formal de noticiero.',
        'Hablá con ritmo ágil, dinámico y frases cortas.' // <-- Cambiado
      ].join(' ');

    const response = await openai.audio.speech.create({
      model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
      // 2. Cambiamos 'verse' por 'onyx' (voz grave/seria) o 'echo' (voz cálida/natural)
      voice: process.env.OPENAI_TTS_VOICE || process.env.NEWS_AGENT_REALTIME_VOICE || 'onyx',
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