#!/usr/bin/env node
'use strict';

/**
 * Comparador antes / después del motor de búsqueda de noticias.  SOLO LECTURA.
 *
 *   npm run test:comparar                 -> todo: baseline + temas + 2 corridas + reporte
 *   npm run test:comparar -- todo --rapido   (≈30 temas, para ver que ande)
 *   npm run test:comparar -- ayuda
 *
 * Qué hace "todo":
 *   1. Crea (una vez) una copia del código "de antes" con git worktree, en una carpeta hermana del repo.
 *   2. Arma la lista de temas: oficiales + libres más pedidos (user_preferences).
 *   3. Corre cada versión contra la MISMA base y con las MISMAS respuestas de OpenAI (caché).
 *   4. Genera test-resultados/reporte.html, comparacion.csv y un resumen por consola.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const { parseArgs } = require('./utilidades');
const { construirTemas, verificarOficialesContraCodigo } = require('./temas');
const { resumir, soloEnComun, compararVersiones, chequeosCordura, veredicto } = require('./metricas');
const { htmlReporte, csvComparacion, textoConsola } = require('./reporte');

const CODE_ROOT = path.resolve(__dirname, '..', '..', '..'); // .../3MinutosBack
const OUT_DIR = path.join(CODE_ROOT, 'test-resultados');
const ENV_PATH = path.join(CODE_ROOT, '.env');
const BASELINE_POR_DEFECTO = '32cac1e'; // último commit ANTES de los cambios de búsqueda (PR #3, #4, #5)

const log = (...a) => console.log(...a);
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const AYUDA = `
Comparador antes / después (solo lectura)

  todo        [--rapido] [--top 150] [--sin-juez] [--baseline <commit>]   Hace todo lo de abajo, en orden
  setup       [--baseline <commit>]   Crea la copia del código "de antes" (git worktree) y deja lista su carpeta
  temas       [--top 150] [--temas-libres "a,b,c"] [--archivo-temas f.txt] [--sin-mongo]   Arma test-resultados/temas.json
  correr      <antes|despues> [--etiqueta nombre] [--solo oficiales|libres] [--sin-juez] [--concurrencia 4]
  comparar    [etiquetaA etiquetaB] [--abrir]   Genera reporte.html, comparacion.csv y el resumen por consola

Ejemplos
  npm run test:comparar -- todo --rapido
  npm run test:comparar -- todo --top 200
  npm run test:comparar -- correr despues --etiqueta despues_f25     (tras cambiar un peso en el código)
  npm run test:comparar -- comparar antes despues_f25 --abrir

Notas
  - Las dos versiones corren al mismo tiempo de la base; no mezcles corridas de días distintos
    (la frescura de las noticias cambia con las horas).
  - OpenAI se cachea en test-resultados/cache: la 2ª corrida es casi gratis y las versiones ven lo mismo.
  - Nada de esto escribe en Mongo ni toca DigestTestLog.
`;

// ------------------------------------------------------------------ baseline

function sonIguales(a, b) {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}

function asegurarBaseline(args) {
  const ref = String(args.baseline || BASELINE_POR_DEFECTO);
  const repo = git(['rev-parse', '--show-toplevel'], CODE_ROOT);
  const rel = path.relative(repo, CODE_ROOT);

  let commit;
  try {
    commit = git(['rev-parse', '--verify', `${ref}^{commit}`], repo);
  } catch {
    throw new Error(`No encuentro el commit "${ref}" en este repo. Probá: git fetch --all   o pasá --baseline <commit>`);
  }

  const wt = path.resolve(args['dir-antes'] || path.join(path.dirname(repo), `${path.basename(repo)}-baseline`));
  if (!fs.existsSync(wt)) {
    log(`• Creando copia del código de antes (${ref === commit.slice(0, ref.length) ? commit.slice(0, 7) : `${ref} = ${commit.slice(0, 7)}`}) en ${wt}`);
    git(['worktree', 'add', '--detach', wt, commit], repo);
  } else {
    let actual;
    try { actual = git(['rev-parse', 'HEAD'], wt); } catch {
      throw new Error(`${wt} existe pero no es un worktree de git. Borralo o usá --dir-antes <otra carpeta>.`);
    }
    if (actual !== commit) {
      log(`• Actualizando la copia de antes a ${commit.slice(0, 7)}`);
      git(['checkout', '--detach', commit], wt);
    }
  }

  const baseRoot = path.join(wt, rel);
  const nm = path.join(baseRoot, 'node_modules');
  if (!fs.existsSync(nm)) {
    let enlazado = false;
    if (sonIguales(path.join(CODE_ROOT, 'package-lock.json'), path.join(baseRoot, 'package-lock.json')) &&
        fs.existsSync(path.join(CODE_ROOT, 'node_modules'))) {
      try {
        fs.symlinkSync(path.join(CODE_ROOT, 'node_modules'), nm, 'junction');
        enlazado = true;
        log('• node_modules enlazado desde el proyecto actual (mismas dependencias)');
      } catch { /* se instala abajo */ }
    }
    if (!enlazado) {
      log('• Instalando dependencias de la copia de antes (npm ci)…');
      const win = process.platform === 'win32';
      execFileSync(win ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
        cwd: baseRoot, stdio: 'inherit', shell: win,
      });
    }
  }
  return { baseRoot, commit, ref };
}

// ------------------------------------------------------------------ temas

async function prepararTemas(args) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const archivo = path.join(OUT_DIR, 'temas.json');
  if (args['reusar-temas'] && fs.existsSync(archivo)) {
    log(`• Reutilizando ${path.relative(process.cwd(), archivo)}`);
    return { archivo, info: JSON.parse(fs.readFileSync(archivo, 'utf8')) };
  }

  const manual = args['temas-libres'] ? String(args['temas-libres']).split(',').map((s) => s.trim()).filter(Boolean) : null;
  let mongoose = null;
  let UserPreference = null;

  if (!manual && !args['archivo-temas'] && !args['sin-mongo']) {
    try {
      if (!process.env.MONGODB_URI) throw new Error('falta MONGODB_URI en el .env');
      mongoose = require('mongoose');
      mongoose.set('autoIndex', false);
      mongoose.set('autoCreate', false);
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000, autoIndex: false });
      UserPreference = require('../../models/UserPreference');
    } catch (e) {
      log(`⚠️  No pude leer user_preferences (${e.message}). Uso la lista de ejemplo para los temas libres.`);
      mongoose = null;
    }
  }

  const opciones = {
    libresManual: manual,
    archivoTemas: args['archivo-temas'] ? path.resolve(args['archivo-temas']) : null,
    top: Number(args.top) || 150,
    rapido: Boolean(args.rapido),
  };
  let info;
  try {
    try {
      info = await construirTemas({ ...opciones, UserPreference });
    } catch (e) {
      if (!UserPreference) throw e;
      log(`⚠️  Falló la lectura de user_preferences (${e.message}). Uso la lista de ejemplo para los temas libres.`);
      info = await construirTemas({ ...opciones, UserPreference: null });
    }
  } finally {
    if (mongoose) await mongoose.disconnect();
  }

  fs.writeFileSync(archivo, JSON.stringify([...info.oficiales, ...info.libres], null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'temas-info.json'), JSON.stringify({ ...info, oficiales: info.oficiales.length, libres: info.libres.length }, null, 2));

  log(`• Temas: ${info.oficiales.length} oficiales + ${info.libres.length} libres — origen libres: ${info.origenLibres}` +
      (info.cobertura ? ` (cubren ${Math.round(100 * info.cobertura)} % de las preferencias libres; hay ${info.distintosEnBase} distintos)` : ''));
  return { archivo, info };
}

// ------------------------------------------------------------------ corridas

function correrHijo({ root, etiqueta, temasPath, args }) {
  const salida = path.join(OUT_DIR, `${etiqueta}.json`);
  const argv = [
    path.join(__dirname, 'corrida.js'),
    '--root', root, '--etiqueta', etiqueta, '--temas', temasPath, '--salida', salida,
    '--cache', path.join(OUT_DIR, 'cache'), '--env', ENV_PATH,
  ];
  if (args.concurrencia) argv.push('--concurrencia', String(args.concurrencia));
  if (args.solo) argv.push('--solo', String(args.solo));
  if (args['sin-juez']) argv.push('--sin-juez');
  if (args.timeout) argv.push('--timeout', String(args.timeout));

  return new Promise((resolve, reject) => {
    const hijo = spawn(process.execPath, argv, {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, DOTENV_CONFIG_QUIET: 'true' },
    });
    hijo.on('error', reject);
    hijo.on('exit', (code) => (code === 0 ? resolve(salida) : reject(new Error(`La corrida "${etiqueta}" terminó con error (código ${code}).`))));
  });
}

// ------------------------------------------------------------------ comparar

function cargar(etiqueta) {
  const archivo = path.join(OUT_DIR, `${etiqueta}.json`);
  if (!fs.existsSync(archivo)) throw new Error(`Falta ${path.relative(process.cwd(), archivo)}. Corré primero:  correr ${etiqueta === 'antes' ? 'antes' : 'despues --etiqueta ' + etiqueta}`);
  return JSON.parse(fs.readFileSync(archivo, 'utf8'));
}

function abrirArchivo(archivo) {
  const [cmd, argv] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', archivo]]
    : process.platform === 'darwin' ? ['open', [archivo]] : ['xdg-open', [archivo]];
  try { spawn(cmd, argv, { detached: true, stdio: 'ignore' }).unref(); } catch { /* sin navegador: se ignora */ }
}

function comparar(args) {
  const etiquetaA = args._[1] || 'antes';
  const etiquetaB = args._[2] || 'despues';
  const comun = soloEnComun(cargar(etiquetaA), cargar(etiquetaB));
  const { A, B } = comun;
  if (comun.excluidosA || comun.excluidosB) {
    log(`ℹ️  Las corridas no cubren los mismos temas: se comparan solo los que están en las dos ` +
        `(quedan afuera ${comun.excluidosA} de "${etiquetaA}" y ${comun.excluidosB} de "${etiquetaB}").`);
  }

  const por = (R, tipo) => resumir(R.resultados.filter((r) => r.tipo === tipo));
  const resA = { oficiales: por(A, 'oficial'), libres: por(A, 'libre') };
  const resB = { oficiales: por(B, 'oficial'), libres: por(B, 'libre') };

  const filas = compararVersiones(A, B);
  const { faltantes } = verificarOficialesContraCodigo(CODE_ROOT);
  const cordura = chequeosCordura(A, B, { faltantesOficiales: faltantes || [] });
  const vered = veredicto(
    resA, resB,
    filas.filter((f) => f.tipo === 'libre'),
    filas.filter((f) => f.tipo === 'oficial')
  );

  let temasInfo = null;
  try { temasInfo = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'temas-info.json'), 'utf8')); } catch { /* opcional */ }

  const ctx = { A, B, resA, resB, filas, cordura, veredicto: vered, temasInfo };
  const html = path.join(OUT_DIR, 'reporte.html');
  const csv = path.join(OUT_DIR, 'comparacion.csv');
  fs.writeFileSync(html, htmlReporte(ctx));
  fs.writeFileSync(csv, csvComparacion(filas));

  log(textoConsola(ctx));
  log(`\nReporte:  ${html}\nPlanilla: ${csv}`);
  if (args.abrir) abrirArchivo(html);
  return vered;
}

// ------------------------------------------------------------------ main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const comando = args._[0] || 'todo';
  if (args.ayuda || comando === 'ayuda' || comando === 'help') { log(AYUDA); return; }

  require('dotenv').config({ path: ENV_PATH, quiet: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  switch (comando) {
    case 'setup': {
      const { baseRoot, commit } = asegurarBaseline(args);
      log(`✔ Código de antes listo: ${baseRoot} (${commit.slice(0, 7)})`);
      break;
    }
    case 'temas':
      await prepararTemas(args);
      break;
    case 'correr': {
      const version = args._[1];
      if (!['antes', 'despues'].includes(version)) throw new Error('Uso: correr <antes|despues> [--etiqueta nombre]');
      const temasPath = path.join(OUT_DIR, 'temas.json');
      if (!fs.existsSync(temasPath)) await prepararTemas(args);
      const root = version === 'antes' ? asegurarBaseline(args).baseRoot : CODE_ROOT;
      await correrHijo({ root, etiqueta: String(args.etiqueta || version), temasPath, args });
      break;
    }
    case 'comparar':
      comparar(args);
      break;
    case 'todo': {
      const t0 = Date.now();
      const { baseRoot } = asegurarBaseline(args);
      const { archivo } = await prepararTemas(args);
      await correrHijo({ root: baseRoot, etiqueta: 'antes', temasPath: archivo, args });
      await correrHijo({ root: CODE_ROOT, etiqueta: 'despues', temasPath: archivo, args });
      comparar({ ...args, _: ['comparar', 'antes', 'despues'] });
      log(`\nListo en ${Math.round((Date.now() - t0) / 1000)} s.`);
      break;
    }
    default:
      throw new Error(`Comando desconocido: "${comando}". Probá:  ayuda`);
  }
}

main().catch((e) => {
  console.error(`\n✖ ${e.message}`);
  process.exit(1);
});
