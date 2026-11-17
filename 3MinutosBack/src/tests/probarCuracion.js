#!/usr/bin/env node
'use strict';

/**
 * probarCuracion.js  (NO GUARDA NADA: solo lee la nota de Mongo y llama a OpenAI)
 *
 * Vuelve a curar una o más notas con el prompt ACTUAL y muestra, lado a lado, el texto que tiene guardado la nota
 * y el que saldría ahora. Sirve para probar un cambio en el prompt de generateNeutralCuration.js con notas reales
 * antes de subirlo.
 *
 * Uso (desde la carpeta 3MinutosBack):
 *   node src/tests/probarCuracion.js <articleId> [<articleId> ...]
 *
 * Ejemplo (los dos errores del digest de Naty del 17/11/2026):
 *   node src/tests/probarCuracion.js 6afb1ad9b1a8c4e93857df7e 6afb1ab1b1a8c4e93857df4a
 *
 * Para que una nota se vuelva a curar DE VERDAD (y se guarde), hay que limpiar su curación en Mongo
 * (curationStatus distinto de 'done'): la próxima vez que salga en un digest se cura con el prompt nuevo.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Article = require('../models/Article');
const { generateNeutralCuration } = require('../curation/generateNeutralCuration');

function bloque(titulo, { neutralTitle, neutralLead, neutralSummary }) {
  return [
    `  ${titulo}`,
    `    título:  ${neutralTitle || '-'}`,
    `    copete:  ${neutralLead || '-'}`,
    `    resumen: ${neutralSummary || '-'}`,
  ].join('\n');
}

async function main() {
  const ids = process.argv.slice(2).filter((a) => /^[0-9a-f]{24}$/i.test(a));
  if (!ids.length) {
    console.log('Uso: node src/tests/probarCuracion.js <articleId> [<articleId> ...]');
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  try {
    for (const id of ids) {
      const guardada = await Article.findById(id).lean();
      if (!guardada) {
        console.log(`\n${id}: no existe`);
        continue;
      }
      console.log(`\n=== ${guardada.title}  (${guardada.sourceName})`);
      console.log(bloque('GUARDADA', guardada));
      const nueva = await generateNeutralCuration(id, { force: true, dryRun: true });
      console.log(bloque(nueva.fallback ? 'NUEVA (falló la IA: texto de respaldo)' : 'NUEVA', nueva));
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Error:', error.message);
    process.exitCode = 1;
  });
}
