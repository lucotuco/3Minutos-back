#!/usr/bin/env node
'use strict';

/**
 * explicarTema.js  (SOLO LECTURA: no escribe nada en Mongo)
 *
 * Muestra CÓMO elige el motor la nota de un tema, oficial o libre: todas las candidatas en el orden del motor, por
 * qué cada una queda afuera y cuál termina ganando. Usa las mismas funciones que producción, así lo que muestra es lo
 * que hace el motor y no una copia que se puede desactualizar.
 *
 * Uso (desde la carpeta 3MinutosBack, donde está tu .env):
 *   node src/tests/explicarTema.js "Tenis Argentino"
 *   node src/tests/explicarTema.js "Fútbol" "Dólar y Mercados"
 *   node src/tests/explicarTema.js --usuario 6a621d21903a120db4315984          (los 3 temas de ese usuario)
 *   node src/tests/explicarTema.js "River Plate" --usuario <id> --hora "2026-11-13 09:00"
 *
 * Opciones:
 *   --usuario <id>   usa el historial de ese usuario (lo que vio en 48 h no se repite, igual que en su digest)
 *                    y, si no pasás temas, toma sus 3 temas
 *   --hora "<fecha>" simula ese momento (hora de Argentina): la ventana de 24 h y la edad se miden desde ahí y se
 *                    ignoran las notas publicadas después. Aproximado: no saca las que se guardaron más tarde.
 *   --top <n>        cuántas candidatas mostrar por tema (por defecto 15)
 *   --sin-juez       no le pregunta al juez de tema (más rápido, sin costo de OpenAI); el motor real corre sin jueces
 *   --json <archivo> además guarda todo el detalle en un archivo
 *
 * Qué usa de OpenAI: la expansión de los temas libres, el embedding de la búsqueda y los jueces (tema y misma
 * historia). Son las mismas llamadas que un digest normal; con --sin-juez quedan solo las dos primeras.
 * No llama a la curación neutral (esa sí escribe en la nota), así que el título que se muestra es el original.
 */

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');

const UserPreference = require('../models/UserPreference');
const articleStore = require('../utils/articleStore');
const { searchArticlesBySimilarityAtlas } = require('../embeddings/searchArticlesBySimilarityAtlas');
const { resolveOfficialTopic } = require('../utils/officialTopics');
const { MAX_ARTICLE_AGE_HOURS } = require('../utils/freshness');
const {
  checkEligibility, rankEligible, hintLevel, IMPORTANCE_GOOD_MIN, IMPORTANCE_ACCEPTABLE_MIN,
} = require('../utils/eligibility');
const { selectBestCandidate } = require('../utils/topicMatching');
const { expandTopic, asExpansion } = require('../utils/topicExpansion');
const { createTopicJudge } = require('../utils/topicJudge');
const { JudgeSession, judgeWaitBudgetMs } = require('../utils/llmJudge');
const { noteForJudge } = require('../utils/judgeNote');
const { getAlreadyShownHistoryForUser } = require('../utils/getAlreadyShownUrlsForUser');
const { pickBestArticlePerTopic } = require('../utils/pickBestArticlePerTopic');

// Igual que el motor (pickBestArticlePerTopic: perTopicLimit 10 * SEARCH_WINDOW_FACTOR 3).
const SEARCH_LIMIT = 30;

// ---------------------------------------------------------------- argumentos

function parseArgs(argv) {
  const out = { temas: [], usuario: null, hora: null, top: 15, sinJuez: false, json: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--usuario') out.usuario = argv[++i];
    else if (a === '--hora') out.hora = argv[++i];
    else if (a === '--top') out.top = Math.max(1, Number(argv[++i]) || 15);
    else if (a === '--sin-juez') out.sinJuez = true;
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--ayuda' || a === '-h') out.ayuda = true;
    else out.temas.push(a);
  }
  return out;
}

/** "2026-11-13 09:00" en hora de Argentina (UTC-3) -> milisegundos. Sin --hora: ahora. */
function parseHora(texto) {
  if (!texto) return Date.now();
  const limpio = String(texto).trim().replace(' ', 'T');
  const conZona = /[zZ]|[+-]\d{2}:?\d{2}$/.test(limpio) ? limpio : `${limpio}-03:00`;
  const t = Date.parse(conZona);
  if (!Number.isFinite(t)) throw new Error(`--hora inválida: "${texto}" (ejemplo: "2026-11-13 09:00")`);
  return t;
}

// ---------------------------------------------------------------- formato

const corto = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const num = (v, d = 1) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '-');
const medioDe = (a) => {
  try { return new URL(a.url).hostname.replace(/^www\./, ''); } catch { return a.sourceName || '?'; }
};
const fechaAR = (ms) => new Date(ms).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hourCycle: 'h23' });
const titulo = (t) => console.log(`\n${'='.repeat(100)}\n${t}\n${'='.repeat(100)}`);
const sub = (t) => console.log(`\n--- ${t}`);

function tabla(filas, columnas) {
  const anchos = columnas.map((c) => Math.max(c.titulo.length, ...filas.map((f) => String(c.valor(f)).length)));
  const linea = (vals) => vals.map((v, i) => String(v).padEnd(anchos[i])).join('  ');
  console.log(linea(columnas.map((c) => c.titulo)));
  console.log(anchos.map((w) => '-'.repeat(w)).join('  '));
  for (const f of filas) console.log(linea(columnas.map((c) => c.valor(f))));
}

function contarMotivos(rechazadas) {
  const c = {};
  for (const r of rechazadas) for (const m of r.reasons) c[m] = (c[m] || 0) + 1;
  return c;
}

// ---------------------------------------------------------------- simular la hora

/** Deja afuera lo publicado después de `now` (para --hora). Con la hora actual no cambia nada. */
const hastaAhora = (now) => (lista) => (lista || []).filter((a) => !a?.publishedAt || new Date(a.publishedAt).getTime() <= now);

function storeHasta(now) {
  const filtrar = hastaAhora(now);
  return {
    ...articleStore,
    listCandidates: async (q) => filtrar(await articleStore.listCandidates(q)),
  };
}

function searchHasta(now) {
  const filtrar = hastaAhora(now);
  return async (exact, vector, opts) => filtrar(await searchArticlesBySimilarityAtlas(exact, vector, opts));
}

// ---------------------------------------------------------------- tema OFICIAL

async function explicarOficial(official, { now, usedUrls, top, store }) {
  const since = new Date(now - MAX_ARTICLE_AGE_HOURS * 3600e3);
  const ctx = { now, usedUrls };

  console.log(`Tipo: OFICIAL (${official.kind === 'subtopic' ? 'subtema' : 'categoría'}) "${official.name}"` +
    `${official.kind === 'subtopic' ? ` de la categoría ${official.category}` : ''}`);
  console.log('Cómo elige: lee las notas por la etiqueta que les puso la IA al ingresarlas (sin búsqueda ni juez de tema).');

  const exact = await store.listCandidates({
    category: official.category,
    topic: official.kind === 'subtopic' ? official.name : null,
    minImportance: IMPORTANCE_ACCEPTABLE_MIN,
    since,
  });
  const ranked = rankEligible(exact, ctx);

  sub(`Candidatas: ${exact.length} con la etiqueta e importancia >= ${IMPORTANCE_ACCEPTABLE_MIN} en 24 h | ` +
    `${ranked.eligible.length} elegibles | ${ranked.rejected.length} descartadas`);
  const motivos = contarMotivos(ranked.rejected);
  if (Object.keys(motivos).length) console.log(`Descartadas por: ${JSON.stringify(motivos)}`);

  sub(`Orden del motor (las ${Math.min(top, ranked.eligible.length)} primeras elegibles)`);
  tabla(ranked.eligible.slice(0, top).map((e, i) => ({ ...e, i: i + 1 })), [
    { titulo: '#', valor: (f) => f.i },
    { titulo: 'nivel', valor: (f) => f.tier },
    { titulo: 'puntaje', valor: (f) => num(f.score) },
    { titulo: 'imp', valor: (f) => f.importance },
    { titulo: 'edad h', valor: (f) => num(f.ageHours) },
    { titulo: 'medio', valor: (f) => corto(medioDe(f.article), 22) },
    { titulo: 'título', valor: (f) => corto(f.article.title, 80) },
  ]);

  if (ranked.rejected.length) {
    sub('Algunas descartadas (para ver que la regla tenga sentido)');
    for (const r of ranked.rejected.slice(0, 8)) {
      console.log(`  [${r.reasons.join(', ')}] imp=${r.article.importanceScore} ${corto(r.article.title, 85)}`);
    }
  }

  let rescate = null;
  if (official.kind === 'subtopic') {
    const near = await store.listCandidates({
      category: official.category, excludeTopic: official.name, minImportance: IMPORTANCE_GOOD_MIN, since,
    });
    const r = rankEligible(near, ctx, { goodOnly: true });
    rescate = r.eligible.slice(0, 5);
    sub(`Si no queda ninguna, el RESCATE ("sugerida") sale de toda la categoría ${official.category} (solo "buenas"). Las primeras:`);
    for (const e of rescate) console.log(`  ${num(e.score)}  ${e.article.topic || '-'} | ${corto(e.article.title, 80)}`);
  }

  return {
    tipo: 'oficial', official,
    candidatas: exact.length,
    elegibles: ranked.eligible.map((e) => resumenEntrada(e)),
    descartadas: motivos,
    rescate: (rescate || []).map((e) => resumenEntrada(e)),
  };
}

// ---------------------------------------------------------------- tema LIBRE

async function explicarLibre(tema, { now, usedUrls, top, sinJuez, search }) {
  const since = new Date(now - MAX_ARTICLE_AGE_HOURS * 3600e3);
  const ctx = { now, usedUrls };

  console.log(`Tipo: LIBRE "${tema}"`);
  console.log('Cómo elige: expande el tema con IA -> búsqueda híbrida (significado + palabras) -> zonas, ancla léxica y ' +
    'corral -> elegibilidad -> orden por calidad -> juez de tema (SI/PARCIAL/NO) -> misma historia -> rescate.');

  let expansion;
  try {
    expansion = asExpansion(await expandTopic(tema), tema);
  } catch (error) {
    console.log(`(la expansión falló: ${error.message}; se busca el tema tal cual)`);
    expansion = asExpansion(null, tema);
  }
  sub('Expansión con IA');
  console.log(`  búsqueda: "${expansion.q}"`);
  console.log(`  pista: categoría=${expansion.cat || '-'} subtema=${expansion.sub || '-'}`);

  const candidatos = await search(tema, expansion.q, { limit: SEARCH_LIMIT, minDate: since });

  const juezActivo = !sinJuez;
  const selection = selectBestCandidate(tema, candidatos, {
    isUsable: (a) => checkEligibility(a, ctx).ok,
    isRepresentative: (a) => checkEligibility(a, { now }).ok,
    exhaustive: true,
    softCorral: juezActivo,
  });

  sub(`Búsqueda: ${candidatos.length} candidatos | corral: ${selection.corral || 'libre'} | ` +
    `anclas: [${selection.anchors.join(', ')}] (${selection.anchorMode}) | aceptados: ${selection.accepted.length}`);
  console.log('Zonas por similitud: VERDE >= 0,94 | AMARILLA 0,80-0,94 (necesita ancla léxica) | ROJA < 0,80 (afuera)');
  tabla(selection.evaluated.slice(0, top).map((row, i) => ({ ...row, i: i + 1, art: candidatos[i] })), [
    { titulo: '#', valor: (f) => f.i },
    { titulo: 'sim', valor: (f) => num(f.score, 3) },
    { titulo: 'zona', valor: (f) => f.zone },
    { titulo: 'categoría', valor: (f) => corto(f.category, 14) },
    { titulo: 'resultado', valor: (f) => corto(f.verdict, 42) },
    { titulo: 'título', valor: (f) => corto(f.title, 70) },
  ]);

  const accepted = new Map(selection.accepted.map((x) => [x.article, x]));
  const { eligible } = rankEligible(selection.accepted.map((x) => x.article), ctx, {
    zoneOf: (a) => accepted.get(a).zone,
    hintOf: (a) => hintLevel(a, expansion),
  });

  // Juez de tema: el mismo que usa el motor (comparte la caché, así el paso 3 no vuelve a preguntar lo mismo).
  const veredictos = new Map();
  if (juezActivo && eligible.length) {
    const judge = createTopicJudge({ session: new JudgeSession({ budgetMs: 60_000 }) });
    if (judge.enabled()) {
      await Promise.all(eligible.slice(0, top).map(async (e) => {
        const r = await judge.verdictFor(tema, noteForJudge(e.article));
        veredictos.set(e.article, r.verdict || `(sin veredicto: ${r.source})`);
      }));
    } else {
      console.log('(el juez de tema está apagado por TOPIC_JUDGE=off)');
    }
  }

  sub(`Orden por calidad de las aceptadas (las ${Math.min(top, eligible.length)} primeras)` +
    `${juezActivo ? ' + veredicto del juez de tema' : ''}`);
  console.log('Primero SI; si no hay ninguna SI, la primera PARCIAL; si tampoco, el rescate. "pista" 2 = subtema sugerido, 1 = categoría.');
  tabla(eligible.slice(0, top).map((e, i) => ({ ...e, i: i + 1 })), [
    { titulo: '#', valor: (f) => f.i },
    { titulo: 'juez', valor: (f) => (juezActivo ? veredictos.get(f.article) || '-' : 'off') },
    { titulo: 'nivel', valor: (f) => f.tier },
    { titulo: 'pista', valor: (f) => f.hint },
    { titulo: 'zona', valor: (f) => f.zone },
    { titulo: 'puntaje', valor: (f) => num(f.score) },
    { titulo: 'imp', valor: (f) => f.importance },
    { titulo: 'edad h', valor: (f) => num(f.ageHours) },
    { titulo: 'medio', valor: (f) => corto(medioDe(f.article), 20) },
    { titulo: 'título', valor: (f) => corto(f.article.title, 70) },
  ]);

  return {
    tipo: 'libre', expansion,
    candidatos: candidatos.length,
    corral: selection.corral, anclas: selection.anchors,
    evaluados: selection.evaluated,
    elegibles: eligible.map((e) => ({ ...resumenEntrada(e), juez: veredictos.get(e.article) || null })),
  };
}

function resumenEntrada(e) {
  return {
    titulo: e.article.title, url: e.article.url, medio: medioDe(e.article),
    categoria: e.article.category, subtema: e.article.topic,
    nivel: e.tier, zona: e.zone || null, pista: e.hint || 0,
    puntaje: Number(num(e.score)), importancia: e.importance, edadHoras: Number(num(e.ageHours)),
  };
}

// ---------------------------------------------------------------- principal

const AYUDA = `
Uso:
  node src/tests/explicarTema.js "<tema>" ["<tema>" ...] [--usuario <id>] [--hora "AAAA-MM-DD HH:MM"] [--top 15] [--sin-juez] [--json archivo]

Ejemplos:
  node src/tests/explicarTema.js "Tenis Argentino"
  node src/tests/explicarTema.js --usuario 6a621d21903a120db4315984
  node src/tests/explicarTema.js "River Plate" --hora "2026-11-13 09:00" --sin-juez
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.ayuda || (!args.temas.length && !args.usuario)) {
    console.log(AYUDA);
    return;
  }

  const now = parseHora(args.hora);
  if (args.sinJuez) {
    // Apaga los jueces de este proceso (no toca el servidor): el motor real corre "como si no existieran".
    process.env.TOPIC_JUDGE = 'off';
    process.env.SAME_STORY_JUDGE = 'off';
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });

  try {
    let temas = args.temas;
    let historial = { urls: [], seenEmbeddings: [] };

    if (args.usuario) {
      const user = await UserPreference.findById(args.usuario).lean();
      if (!user) throw new Error(`No existe el usuario ${args.usuario}`);
      if (!temas.length) temas = user.topics || [];
      historial = await getAlreadyShownHistoryForUser(user._id, { now });
      console.log(`Usuario: ${user.name} (${args.usuario}) | temas: ${(user.topics || []).join(', ')}`);
      console.log(`Historial de 48 h: ${historial.urls.length} notas ya vistas (no se repiten) y ` +
        `${historial.seenEmbeddings.length} para el control de misma historia`);
    } else {
      console.log('Sin --usuario: como un usuario nuevo (sin historial).');
    }
    console.log(`Momento: ${fechaAR(now)} (hora de Argentina)${args.hora ? ' [simulado]' : ''}`);
    console.log(`Jueces: ${args.sinJuez ? 'apagados (--sin-juez)' : 'prendidos'}`);

    const store = storeHasta(now);
    const search = searchHasta(now);
    const usedUrls = new Set(historial.urls);
    const salida = { momento: new Date(now).toISOString(), usuario: args.usuario, temas: [] };

    // 1 y 2: cada tema, con todas sus candidatas
    for (const tema of temas) {
      titulo(`TEMA: ${tema}`);
      const official = resolveOfficialTopic(String(tema).trim());
      const detalle = official
        ? await explicarOficial(official, { now, usedUrls, top: args.top, store })
        : await explicarLibre(String(tema).trim(), { now, usedUrls, top: args.top, sinJuez: args.sinJuez, search });
      salida.temas.push({ tema, ...detalle });
    }

    // 3: el motor real, con todos los temas juntos (como en el digest: no repite nota ni historia entre temas)
    titulo('LO QUE ENTREGA EL MOTOR REAL (pickBestArticlePerTopic, mismas reglas que producción)');
    console.log('Abajo van primero los logs del motor tal cual los escribe en Render.\n');
    const picks = await pickBestArticlePerTopic(temas, {
      now,
      alreadyShownUrls: historial.urls,
      seenEmbeddings: historial.seenEmbeddings,
      judgeWaitMs: judgeWaitBudgetMs({ background: true }),
      deps: { store, search },
    });

    sub('Resultado');
    for (const p of picks) {
      const a = p.article;
      console.log(`\n• ${p.topic}`);
      if (!a) {
        console.log(`  SIN NOTA (${p.matchReason})`);
        continue;
      }
      console.log(`  ${a.title}`);
      console.log(`  ${medioDe(a)} | nivel ${p.tier}${p.usedFallback ? ' (RESCATE: es de otro tema del rubro)' : ''} | ` +
        `zona ${p.matchZone} | ${num(p.ageHours)} h | imp ${a.importanceScore}`);
      console.log(`  motivo: ${p.matchReason}`);
      console.log(`  ${a.url}`);
    }

    salida.resultado = picks.map((p) => ({
      tema: p.topic,
      titulo: p.article?.title || null,
      url: p.article?.url || null,
      nivel: p.tier, zona: p.matchZone, rescate: Boolean(p.usedFallback),
      edadHoras: p.ageHours, motivo: p.matchReason,
    }));

    if (args.json) {
      fs.writeFileSync(args.json, JSON.stringify(salida, null, 2));
      console.log(`\nDetalle guardado en ${args.json}`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('\nError:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, parseHora };
