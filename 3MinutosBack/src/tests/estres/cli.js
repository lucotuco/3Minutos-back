#!/usr/bin/env node
'use strict';

/**
 * Test de estrés del motor de búsqueda y del armado de digests (SOLO el código actual).
 *
 *   npm run test:estres -- --nivel suave --dry-run     (muestra el plan, no se conecta a nada)
 *   npm run test:estres -- --nivel suave
 *   npm run test:estres -- --nivel maximo
 *
 * Solo lectura sobre Mongo. Usa tus claves de OpenAI (cuenta las llamadas y respeta --max-openai).
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFile } = require('child_process');

const { parseArgs, lista } = require('./args');
const { resolverNivel, hostilesDe } = require('./config');
const { planificar, textoPlan, ID_ESCENARIOS } = require('./plan');
const { crearPresupuesto, crearControl, topErrores } = require('./instrumentos');
const { leerFuentes, auditarFuentes } = require('./estatico');
const { hallazgosGlobales } = require('./analisis_d');
const { construirReporte, textoConsola, guardarReporte, ICONO } = require('./reporte');
const { htmlReporte } = require('./reporte_html');
const { crearEntorno, describirUri } = require('./entorno');
const { ESCENARIOS } = require('./escenarios');

const SRC = path.resolve(__dirname, '..', '..');
const RAIZ = path.resolve(SRC, '..');
const salidaPorDefecto = (t = '') => process.stdout.write(`${t}\n`);

const AYUDA = `
Test de estrés 3Minutos (solo el código actual; solo lectura sobre Mongo)

  npm run test:estres -- [opciones]
  node --expose-gc src/tests/estres/cli.js [opciones]

Niveles: suave (por defecto) | medio | maximo

Opciones
  --nivel N                 suave, medio o maximo
  --dry-run                 muestra el plan y NO se conecta a nada
  --si                      no pide confirmación (necesario si no hay terminal interactiva)
  --solo A,B                solo esos escenarios        --saltar D,F   todos menos esos
      A repetición por tópico · B sesiones con historial · C tríos solapados
      D carga y concurrencia · E hostiles y variantes · F soak
  --repeticiones N          repeticiones por tópico (A)
  --rondas N                rondas por tópico y por sesión (B)
  --libres N                cuántos tópicos libres (los más pedidos de user_preferences)
  --concurrencia N          paralelismo base de A, B, C y E
  --rampa 1,2,4,8           escalones de la rampa (D)    --concurrencia-max N   tope de la rampa
  --seguir-tras-quiebre     no cortar la rampa en el primer escalón que se quiebra
  --soak-minutos N          duración del soak (F)
  --timeout S               timeout por llamada, en segundos
  --max-openai N            tope de llamadas a OpenAI (al llegar, corta y entrega lo que haya)
  --max-minutos N           tope de duración total
  --temas-libres "a,b,c"    usar estos tópicos libres en vez de los de user_preferences
  --archivo-temas ruta      un tópico libre por línea
  --sin-usuarios            no leer usuarios: se omiten el digest completo y la prueba del candado
  --cache-openai            caché de OpenAI en disco (repetir sin costo; oculta 429 y latencia real)
  --semilla N               semilla del muestreo (misma semilla, mismos tópicos)
  --salida carpeta          dónde guardar el reporte    --env ruta   .env a usar
  --abrir                   abre el HTML al terminar    --sin-estatico   omite la auditoría de código
  Ctrl+C                    corta ordenadamente y arma el reporte con lo que haya (parcial)
`;

function elegirEscenarios(args) {
  const solo = lista(args.solo).map((s) => s.toUpperCase());
  const saltar = lista(args.saltar).map((s) => s.toUpperCase());
  const invalidos = [...solo, ...saltar].filter((id) => !ID_ESCENARIOS.includes(id));
  if (invalidos.length) throw new Error(`Escenario desconocido: ${invalidos.join(', ')}. Opciones: ${ID_ESCENARIOS.join(', ')}`);
  return ID_ESCENARIOS.filter((id) => (!solo.length || solo.includes(id)) && !saltar.includes(id));
}

function confirmar(texto) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(texto, (r) => { rl.close(); resolve(/^(si|sí|s|yes|y)$/i.test(String(r).trim())); });
  });
}

function abrir(archivo) {
  const [cmd, ...a] = process.platform === 'darwin' ? ['open', archivo]
    : process.platform === 'win32' ? ['cmd', '/c', 'start', '', archivo] : ['xdg-open', archivo];
  execFile(cmd, a, () => {});
}

function mostrarEstatico(estatico, out) {
  const visibles = estatico.filter((x) => x.severidad !== 'INFO');
  const informativos = estatico.length - visibles.length;
  out(`  Auditoría estática del código actual: ${estatico.length} hallazgo(s)${informativos ? ` (${informativos} solo informativo(s): van en el reporte)` : ''}.`);
  for (const h of visibles) out(`    ${ICONO[h.severidad]} ${h.titulo}`);
}

/**
 * @param {string[]} argv
 * @param {object} [deps]  solo para los tests unitarios: { out, crearEntorno, sinSenales }
 * @returns {Promise<number>} código de salida
 */
async function main(argv = process.argv.slice(2), deps = {}) {
  const out = deps.out || salidaPorDefecto;
  const abrirEntorno = deps.crearEntorno || crearEntorno;
  const args = parseArgs(argv);
  if (args.ayuda || args.h) { out(AYUDA); return 0; }

  const nivel = resolverNivel(String(args.nivel || 'suave'), args);
  const escenarios = elegirEscenarios(args);
  const estatico = args['sin-estatico'] ? [] : auditarFuentes(leerFuentes(SRC));

  const plan = planificar(nivel, {
    oficiales: nivel.oficiales === 'categorias' ? 7 : 45,
    libres: nivel.libres,
    usuarios: args['sin-usuarios'] ? 0 : 1,
    hostiles: hostilesDe(nivel.E.hostiles).length,
    escenarios,
  });
  out(textoPlan(nivel, plan));
  mostrarEstatico(estatico, out);
  if (args['dry-run']) { out('\n(--dry-run: no se conectó a Mongo ni a OpenAI.)'); return 0; }

  // ---- seguridad antes de conectar
  const envPath = args.env ? path.resolve(args.env) : path.join(RAIZ, '.env');
  if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath, quiet: true });
  if (!process.env.MONGODB_URI) throw new Error(`Falta MONGODB_URI (busqué un .env en ${envPath})`);
  const destino = describirUri(process.env.MONGODB_URI);
  out(`\n⚠  Se va a ejecutar contra ${destino.host} · base "${destino.base || '(la que indique la URI)'}"`);
  out('   Es SOLO LECTURA sobre Mongo, pero carga a Atlas y gasta tu cuota de OpenAI (claves del .env). Conviene correrlo fuera de horario pico.');
  if (!args.si) {
    if (!process.stdin.isTTY) throw new Error('No hay terminal interactiva: pasá --si para confirmar.');
    if (!(await confirmar('¿Seguimos? (escribí SI) '))) { out('Cancelado.'); return 0; }
  }

  const presupuesto = crearPresupuesto(nivel.maxOpenAI);
  const control = crearControl({ maxMinutos: nivel.maxMinutos, presupuesto });
  if (!deps.sinSenales) {
    process.once('SIGINT', () => {
      control.solicitar('interrumpida con Ctrl+C');
      out('\n⏹  Ctrl+C: termino las tareas en curso y armo el reporte parcial (otro Ctrl+C corta ya).');
    });
  }

  const inicio = Date.now();
  const { ctx, cerrar } = await abrirEntorno({ nivel, args, log: out, presupuesto, control });
  const m = ctx.meta;
  out(`\nConectado: base "${m.baseConectada}" · notas de las últimas 48 h: ${m.articulos48h ?? 'n/d'} · commit ${m.commit || '?'} (${m.rama || '?'})`);
  out(`Tópicos: ${ctx.temas.oficiales.length} oficiales + ${ctx.temas.libres.length} libres (${ctx.temas.origenLibres}) · usuarios activos: ${ctx.usuarios.length}` +
    ` · digest completo: ${ctx.tieneDigest ? 'sí' : `no (${ctx.motivoSinDigest})`}${m.cacheOpenAI ? ' · caché OpenAI en disco' : ''}`);

  const resultados = [];
  const erroresInternos = [];
  for (const E of ESCENARIOS.filter((e) => escenarios.includes(e.ID))) {
    if (control.detener()) { out(`⏭  ${E.ID} omitido (${control.motivo()})`); continue; }
    out(`\n▶ ${E.ID} · ${E.NOMBRE}`);
    const t0 = Date.now();
    try {
      const r = await E.correr(ctx);
      if (!r) { out(`   ${E.ID}: no aplica con esta configuración`); continue; }
      resultados.push(r);
      for (const mensaje of r.erroresInternos || []) erroresInternos.push({ escenario: E.ID, mensaje });
      out(`✔ ${E.ID}: ${r.hallazgos.length} hallazgo(s) en ${Math.round((Date.now() - t0) / 1000)} s${r.parcial ? ' (parcial)' : ''}`);
    } catch (e) {
      erroresInternos.push({ escenario: E.ID, mensaje: e.stack || e.message });
      out(`✖ ${E.ID} se cortó por un error del propio test: ${e.message}`);
    }
  }

  control.detener(); // materializa el motivo si fue por tiempo o presupuesto
  const contadores = ctx.contar();
  const parcial = Boolean(control.motivo()) || resultados.some((r) => r.parcial);
  const meta = {
    ...m, nivel: nivel.nombre, iniciadoEn: new Date(inicio).toISOString(), duracionMin: Math.round((Date.now() - inicio) / 6000) / 10,
    parcial, motivoParada: control.motivo(), semilla: Number(args.semilla) || 20260101, escenarios,
    openaiUsadas: presupuesto.usado(), maxOpenAI: nivel.maxOpenAI,
  };
  const rep = construirReporte({
    meta, plan, escenarios: resultados, estatico, contadores, topErrores: topErrores(ctx.contadores), erroresInternos,
    globales: hallazgosGlobales({ contadores, parcial, motivoParada: control.motivo() }),
  });
  const stamp = new Date(inicio).toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const dir = args.salida ? path.resolve(args.salida) : path.join(RAIZ, 'test-resultados', `estres-${nivel.nombre}-${stamp}`);
  const archivos = guardarReporte(rep, dir, htmlReporte);
  out(textoConsola(rep, Object.values(archivos)));

  await cerrar();
  if (args.abrir) abrir(archivos.html);
  return 0;
}

if (require.main === module) {
  main().then((codigo) => process.exit(codigo)).catch((e) => {
    process.stderr.write(`✖ ${e.stack || e.message}\n`);
    process.exit(1);
  });
}

module.exports = { main, elegirEscenarios, AYUDA };
