/**
 * auditarCandidatos.js  (SOLO LECTURA: no escribe nada en Mongo)
 *
 * Reproduce lo que hace pickBestArticlePerTopic para un tópico libre y vuelca
 * TODOS los candidatos (no solo el primero) con su score, su zona, si pasan el
 * chequeo léxico actual y si son ELEGIBLES (vigente, importancia, país, sin opinión
 * ni previa) con el motivo cuando no lo son.
 * No aplica el filtro de "misma historia": necesita los embeddings de lo que el usuario ya vio.
 *
 * Uso (desde la carpeta 3MinutosBack, donde está tu .env):
 *   node auditarCandidatos.js
 *   node auditarCandidatos.js "river plate" "boca juniors"
 *
 * Genera candidatos_auditoria.json con el detalle. Subilo para que lo analice.
 */
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { searchArticlesBySimilarityAtlas } = require('../embeddings/searchArticlesBySimilarityAtlas');
const { MAX_ARTICLE_AGE_HOURS: MAX_AGE_HOURS } = require('../utils/freshness'); // 24 h
const { checkEligibility } = require('../utils/eligibility');

const LIMIT = 30; // igual que perTopicLimit * 3 (la ventana de candidatos del motor)

// Expansiones reales que aparecen en tus logs; si pasás otros tópicos por
// consola se corre solo la variante "sin expansión".
const EXPANDED = {
  'river plate': 'river plate club de fútbol argentino afp caba estadio monumental superclásico',
  'boca juniors': 'boca juniors club de fútbol argentino bombonera xeneizes',
};

const DEFAULT_TOPICS = ['river plate', 'boca juniors'];

function norm(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function zoneOf(score) {
  if (score >= 0.94) return 'VERDE';
  if (score >= 0.80) return 'AMARILLA';
  return 'ROJA';
}

// Copia fiel del chequeo léxico actual (zona amarilla).
function lexicalCurrent(topic, a) {
  const topicClean = norm(topic);
  const content = norm(`${a.title} ${a.rawSummary} ${a.contentSnippet} ${(a.tags || []).join(' ')}`);
  const words = topicClean.split(' ').filter((w) => w.length >= 3);
  if (words.length === 0) return content.includes(topicClean);
  if (words.length <= 3) return content.includes(topicClean) || words.every((w) => content.includes(w));
  const matched = words.filter((w) => content.includes(w));
  return matched.length >= Math.ceil(words.length * 0.75) || content.includes(topicClean);
}

// Variante exploratoria: alcanza con UNA palabra del tópico (palabra completa).
function lexicalAnyWord(topic, a) {
  const content = ' ' + norm(`${a.title} ${a.rawSummary} ${a.contentSnippet} ${(a.tags || []).join(' ')}`).replace(/[^a-z0-9ñ]+/g, ' ') + ' ';
  const words = norm(topic).split(' ').filter((w) => w.length >= 3);
  return words.some((w) => content.includes(' ' + w + ' '));
}

async function runVariant(topic, vectorQuery, label) {
  const now = Date.now();
  const results = await searchArticlesBySimilarityAtlas(topic, vectorQuery, {
    limit: LIMIT,
    minDate: new Date(now - MAX_AGE_HOURS * 3600 * 1000),
    // sin category: los tópicos libres corren "Corral: Libre", como en producción
  });
  return results.map((a, i) => {
    const ev = checkEligibility(a, { now });
    return {
      variant: label,
      rank: i + 1,
      score: Number((a.score || 0).toFixed(3)),
      finalScore: Number((a.finalScore || 0).toFixed(1)),
      zone: zoneOf(a.score || 0),
      lexicalActual: lexicalCurrent(topic, a),
      lexicalAlgunaPalabra: lexicalAnyWord(topic, a),
      elegible: ev.ok,
      nivel: ev.tier,
      motivosNoElegible: ev.reasons,
      category: a.category,
      topic: a.topic,
      geoScope: a.geoScope,
      source: a.sourceName,
      publishedAt: a.publishedAt,
      edadHoras: ev.ageHours === null ? null : Number(ev.ageHours.toFixed(1)),
      importanceScore: a.importanceScore,
      tags: a.tags,
      title: a.title,
      url: a.url,
    };
  });
}

(async () => {
  const args = process.argv.slice(2);
  const topics = args.length ? args : DEFAULT_TOPICS;

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Conectado a:', mongoose.connection.name);

  const out = {};
  for (const topic of topics) {
    out[topic] = [];
    out[topic].push(...(await runVariant(topic, topic, 'sin_expansion')));
    const expanded = EXPANDED[norm(topic)];
    if (expanded) out[topic].push(...(await runVariant(topic, expanded, 'con_expansion')));

    for (const variant of ['sin_expansion', 'con_expansion']) {
      const rows = out[topic].filter((r) => r.variant === variant);
      if (!rows.length) continue;
      console.log(`\n=== "${topic}" [${variant}] -> ${rows.length} candidatos ===`);
      console.log('rank | score | zona     | lexAct | lexAlg | elegible          | cat          | titulo');
      for (const r of rows) {
        const elegible = r.elegible ? `si (${r.nivel})` : `NO ${r.motivosNoElegible.join(',')}`;
        console.log(
          `${String(r.rank).padStart(4)} | ${r.score.toFixed(3)} | ${r.zone.padEnd(8)} | ` +
          `${r.lexicalActual ? 'si ' : 'NO '}   | ${r.lexicalAlgunaPalabra ? 'si ' : 'NO '}   | ` +
          `${elegible.slice(0, 17).padEnd(17)} | ${String(r.category).slice(0, 12).padEnd(12)} | ${String(r.title).slice(0, 70)}`
        );
      }
    }
  }

  fs.writeFileSync('candidatos_auditoria.json', JSON.stringify(out, null, 2));
  console.log('\nListo: candidatos_auditoria.json');
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
