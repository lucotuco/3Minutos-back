'use strict';

/**
 * Corre los 6 escenarios del test de estrés (y el CLI de punta a punta) contra un entorno
 * 100 % FALSO (ver estres.fake.js): sin Mongo, sin OpenAI, sin red.
 * Se prueba que (1) con un sistema sano no inventan problemas, (2) cada falla inyectada
 * se detecta, (3) el plan que muestra --dry-run coincide con lo que de verdad hacen,
 * (4) cortar la corrida deja un reporte parcial y (5) el CLI no filtra credenciales.
 *   npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { norm } = require('../comparar/utilidades');
const { crearFalso, nivelChico } = require('./estres.fake');
const A = require('../estres/escenarios/a_repeticion');
const B = require('../estres/escenarios/b_sesion');
const C = require('../estres/escenarios/c_multitopico');
const D = require('../estres/escenarios/d_carga');
const E = require('../estres/escenarios/e_hostiles');
const F = require('../estres/escenarios/f_soak');
const { ESCENARIOS, porId } = require('../estres/escenarios');
const { tamanios, hostilesDe, CONTRATO } = require('../estres/config');
const { crearControl, crearPresupuesto } = require('../estres/instrumentos');
const { construirReporte } = require('../estres/reporte');
const { htmlReporte } = require('../estres/reporte_html');
const { hallazgosGlobales } = require('../estres/analisis_d');
const { main } = require('../estres/cli');

const GRAVES = ['CRITICA', 'ALTA', 'MEDIA'];
const ids = (r) => r.hallazgos.map((h) => h.id);
const graves = (r) => r.hallazgos.filter((h) => GRAVES.includes(h.severidad)).map((h) => `${h.severidad} ${h.id}`);
const hallazgo = (r, id) => r.hallazgos.find((h) => h.id === id);

async function correr(escenario, opciones = {}) {
  const falso = crearFalso(opciones);
  const r = await escenario.correr(falso.ctx);
  return { r, ...falso };
}

// ================================================================= sistema sano: no se inventan problemas
for (const [nombre, escenario] of [['A', A], ['B', B], ['C', C], ['D', D], ['E', E]]) {
  test(`${nombre} con un sistema sano no reporta problemas de severidad media o mayor`, async () => {
    const { r } = await correr(escenario);
    assert.deepEqual(graves(r), []);
    assert.deepEqual(r.erroresInternos, []);
    assert.equal(r.parcial, false);
    assert.equal(r.id, nombre);
  });
}

test('F (soak) con un sistema sano no reporta problemas y toma muestras', async () => {
  const { r } = await correr(F, { nivel: nivelChico({ F: { minutos: 0.006, intervaloMs: 30 } }) });
  assert.deepEqual(graves(r), []);
  assert.ok(r.muestras.length >= 1);
  assert.ok(r.resumen.tareas > 0);
  assert.equal(r.resumen.concurrencia, 3);
  assert.equal(r.parcial, false);
});

test('F no corre con 0 minutos ni sin tópicos', async () => {
  assert.equal((await correr(F)).r, null);
  const sinTemas = crearFalso({ nivel: nivelChico({ F: { minutos: 0.01 } }) });
  sinTemas.ctx.temas = { oficiales: [], libres: [], origenLibres: 'vacío' };
  assert.equal(await F.correr(sinTemas.ctx), null);
});

test('el registro de escenarios está completo y ordenado', () => {
  assert.deepEqual(ESCENARIOS.map((e) => e.ID), ['A', 'B', 'C', 'D', 'E', 'F']);
  for (const e of ESCENARIOS) assert.ok(typeof e.correr === 'function' && e.NOMBRE, e.ID);
  assert.equal(porId('c').ID, 'C');
  assert.equal(porId('Z'), null);
});

// ================================================================= A: repetición
test('A detecta resultados que cambian de ida y vuelta (no determinismo)', async () => {
  const { r } = await correr(A, { fallas: { inestable: true } });
  const h = hallazgo(r, 'A-FLAPPING');
  assert.equal(h.severidad, 'ALTA');
  assert.ok(r.porTema.every((t) => t.distintos === 2 && t.transiciones === 2));
});

test('A detecta errores de búsqueda disfrazados de rescate, rescates intermitentes y rescate "monocultivo"', async () => {
  const { r, ctx } = await correr(A, { fallas: { errorBusquedaCada: 2 } });
  assert.equal(hallazgo(r, 'A-ERROR-BUSQUEDA-TRAGADO').severidad, 'ALTA');
  assert.equal(hallazgo(r, 'A-RESCATE-INTERMITENTE').severidad, 'ALTA');
  const hub = hallazgo(r, 'A-NOTA-REPETIDA-ENTRE-TEMAS');
  assert.ok(hub, 'todos los rescates de una categoría devuelven la misma nota');
  // Un error de búsqueda en un tema libre cae al rescate; en un tema oficial (que se lee por etiqueta) deja el lugar vacío.
  assert.equal(r.resumen.clases.rescate, ctx.temas.libres.length, 'los 6 libres rescatan');
  assert.equal(r.resumen.clases.vacio, ctx.temas.oficiales.length, 'las 7 categorías no rescatan nunca: quedan vacías');
  assert.equal(r.resumen.causasNoTema.error_busqueda, r.resumen.clases.rescate + r.resumen.clases.vacio);
});

test('A detecta tópicos que lanzan error', async () => {
  const { r } = await correr(A, { fallas: { lanzarPara: ['river plate'] } });
  const h = hallazgo(r, 'A-ERRORES');
  assert.equal(h.severidad, 'ALTA');
  assert.match(h.evidencia[0], /"river plate": 3\/3/);
  assert.equal(r.erroresInternos.length, 0, 'un error de pick no es un error del test');
});

test('A detecta la misma nota entregada a muchos tópicos distintos', async () => {
  const { r } = await correr(A, { fallas: { mismaNotaParaTodos: true } });
  assert.equal(hallazgo(r, 'A-NOTA-REPETIDA-ENTRE-TEMAS').severidad, 'MEDIA');
});

test('A hace exactamente tópicos × repeticiones llamadas y cada tópico tiene una fila por repetición', async () => {
  const { r, llamadas, ctx } = await correr(A);
  const n = ctx.temas.oficiales.length + ctx.temas.libres.length;
  assert.equal(llamadas.pick, n * ctx.nivel.A.repeticiones);
  assert.equal(r.filas.length, llamadas.pick);
  assert.equal(r.llamadasPlaneadas, llamadas.pick);
  assert.equal(r.resumen.topicos, n);
  assert.ok(r.porTema.every((t) => t.n === ctx.nivel.A.repeticiones));
  assert.equal(r.resumen.pctEstables, 100);
});

// ================================================================= B: sesiones con historial
test('B detecta que se repita una nota que el usuario ya vio (historial ignorado)', async () => {
  const { r } = await correr(B, { fallas: { ignorarHistorial: true } });
  assert.equal(hallazgo(r, 'B-I7-REPETIDO-HISTORIAL').severidad, 'CRITICA');
  assert.ok(r.porTema.some((t) => t.repetidas > 0));
});

test('B: una sesión larga hace reaparecer notas cuando salen del tope del historial (150 notas)', async () => {
  const tope = CONTRATO.ventanaHistorial; // 150 notas = 50 rondas de un usuario con 3 tópicos
  const rondasHastaElTope = tope / 3;

  // Una ronda más allá del tope: la nota más vieja sale del historial y, como sigue vigente, vuelve a entregarse.
  const largo = nivelChico({ B: { temas: 1, rondas: 1, sesiones: 1, rondasSesion: rondasHastaElTope + 2 } });
  const { r } = await correr(B, { nivel: largo, articulosPorTema: rondasHastaElTope + 1 });
  const h = hallazgo(r, 'B-REAPARICION');
  assert.equal(h.severidad, 'ALTA');
  assert.ok(r.resumen.reaparecidas >= 1);
  assert.match(h.titulo, new RegExp(`${tope} notas`));
  assert.ok(!ids(r).includes('B-I7-REPETIDO-HISTORIAL'), 'no es una violación del historial: la nota ya había salido de él');

  // Justo en el tope (50 rondas = 150 notas) todo sigue dentro del historial: no reaparece nada.
  const justo = nivelChico({ B: { temas: 1, rondas: 1, sesiones: 1, rondasSesion: rondasHastaElTope } });
  const sano = await correr(B, { nivel: justo, articulosPorTema: rondasHastaElTope + 1 });
  assert.ok(!ids(sano.r).includes('B-REAPARICION'), `${rondasHastaElTope} rondas × 3 = ${tope} notas: todavía dentro del historial`);
});

test('B le pasa al motor lo ya visto (URLs y embeddings), como producción, y lo acota al historial', async () => {
  const nivel = nivelChico({ B: { temas: 0, rondas: 1, sesiones: 1, rondasSesion: 3 } });
  const vectores = (ids2) => new Map(ids2.map((id, i) => [id, [1, i, 0]]));
  const falso = crearFalso({ nivel, fallas: { vectores } });
  const llamadasPick = [];
  const original = falso.ctx.pick;
  falso.ctx.pick = (topics, opts) => { llamadasPick.push({ topics, opts }); return original(topics, opts); };

  const r = await B.correr(falso.ctx);
  const sesion = llamadasPick.filter((c) => c.topics.length === 3);
  assert.equal(sesion.length, 3);
  assert.deepEqual(sesion[0].opts.alreadyShownUrls, []);
  assert.deepEqual(sesion[0].opts.seenEmbeddings, []);

  // En la 2.ª y 3.ª ronda el motor recibe las notas de las rondas anteriores, con su embedding real.
  assert.equal(sesion[1].opts.alreadyShownUrls.length, 3);
  assert.equal(sesion[1].opts.seenEmbeddings.length, 3);
  assert.equal(sesion[2].opts.alreadyShownUrls.length, 6);
  assert.equal(sesion[2].opts.seenEmbeddings.length, 6);
  for (const e of sesion[2].opts.seenEmbeddings) {
    assert.equal(typeof e.title, 'string');
    assert.ok(Array.isArray(e.vector) && e.vector.length === 3);
  }
  assert.deepEqual(r.erroresInternos, []);
});

test('B sigue sin embeddings si no se pueden leer: avisa una sola vez por ese motivo y pasa solo las URLs', async () => {
  const nivel = nivelChico({ B: { temas: 0, rondas: 1, sesiones: 1, rondasSesion: 3 } });
  const falso = crearFalso({ nivel, fallas: { vectores: () => { throw new Error('mongo caído'); } } });
  const pasados = [];
  const original = falso.ctx.pick;
  falso.ctx.pick = (topics, opts) => { pasados.push(opts); return original(topics, opts); };

  const r = await B.correr(falso.ctx);
  assert.ok(pasados.every((o) => Array.isArray(o.seenEmbeddings) && o.seenEmbeddings.length === 0));
  assert.equal(pasados[2].alreadyShownUrls.length, 6, 'las URLs sí se pasan');
  const avisos = r.erroresInternos.filter((m) => /para pasarle al motor lo ya visto: mongo caído/.test(m));
  assert.equal(avisos.length, 1, 'no se repite el aviso en cada ronda');
});

test('B: un tópico con pocas notas se agota (rescate y después vacío)', async () => {
  const nivel = nivelChico({ B: { temas: 13, rondas: 3, sesiones: 0, rondasSesion: 3 } });
  const { r } = await correr(B, { nivel, articulosPorTema: 1 });
  assert.equal(hallazgo(r, 'B-AGOTAMIENTO-RAPIDO').severidad, 'INFO');
  assert.equal(hallazgo(r, 'B-SIN-NOTICIA').severidad, 'MEDIA');
  const rio = r.porTema.find((t) => t.tema === 'river plate');
  assert.deepEqual([rio.conTema, rio.rescates, rio.primeraRescate, rio.primeraVacia], [1, 1, 2, 3]);
});

test('B usa embeddings reales si los hay, y si no se pueden leer lo informa sin romperse', async () => {
  const iguales = (ids2) => new Map(ids2.map((id) => [id, [1, 0, 0]]));
  const conVectores = await correr(B, { fallas: { vectores: iguales } });
  assert.equal(conVectores.r.usoEmbeddingsReales, true);
  assert.equal(hallazgo(conVectores.r, 'B-CASI-DUPLICADOS').severidad, 'ALTA', 'vectores idénticos = misma historia');

  const roto = await correr(B, { fallas: { vectores: () => { throw new Error('mongo caído'); } } });
  assert.ok(roto.r.erroresInternos.some((m) => /no se pudieron leer embeddings.*mongo caído/.test(m)));
  assert.equal(roto.r.usoEmbeddingsReales, false);
  assert.deepEqual(graves(roto.r), [], 'el análisis sigue con la similitud de títulos');
});

test('B hace exactamente las rondas planeadas', async () => {
  const { r, llamadas, ctx } = await correr(B);
  const n = ctx.nivel.B;
  assert.equal(llamadas.pick, n.temas * n.rondas + n.sesiones * n.rondasSesion);
  assert.equal(r.rondasTema.length, n.temas * n.rondas);
  assert.equal(r.sesiones.length, n.sesiones * n.rondasSesion);
  assert.equal(r.llamadasPlaneadas, llamadas.pick);
});

test('triosParaSesiones: n tríos de 3 tópicos, con o sin usuarios reales', () => {
  const con = crearFalso().ctx;
  const sin = crearFalso({ usuarios: 0 }).ctx;
  for (const ctx of [con, sin]) {
    const trios = B.triosParaSesiones(ctx, 10);
    assert.equal(trios.length, 10);
    assert.ok(trios.every((t) => t.length === 3 && t.every((x) => typeof x === 'string' && x)));
  }
});

// ================================================================= C: tríos solapados
test('C detecta notas casi iguales dentro de un mismo digest', async () => {
  const { r } = await correr(C, { fallas: { casiDuplicados: true } });
  assert.equal(hallazgo(r, 'C-CASI-DUPLICADOS-EN-LLAMADA').severidad, 'MEDIA');
  const conVector = await correr(C, { fallas: { casiDuplicados: true, vectores: (i) => new Map(i.map((id) => [id, [1, 0]])) } });
  assert.equal(hallazgo(conVector.r, 'C-CASI-DUPLICADOS-EN-LLAMADA').severidad, 'ALTA');
});

test('C detecta que un tópico reciba otra nota según su posición en la lista', async () => {
  const { r } = await correr(C, { fallas: { mismaNotaParaTodos: true } });
  assert.equal(hallazgo(r, 'C-DEPENDE-DEL-ORDEN').severidad, 'MEDIA');
  assert.ok(r.resumen.topicosDependientesDelOrden > 0);
});

test('C detecta la misma nota para dos tópicos de una llamada (I8, crítico)', async () => {
  const { r } = await correr(C, { fallas: { mismaNotaParaTodos: true, sinDedupe: true } });
  assert.equal(hallazgo(r, 'C-I8-DUPLICADO-LLAMADA').severidad, 'CRITICA');
});

test('C prueba todas las permutaciones de cada trío, cada una con sus repeticiones', async () => {
  const { r, llamadas, ctx } = await correr(C);
  assert.equal(llamadas.pick, ctx.nivel.C.triplas * 6 * ctx.nivel.C.repeticiones);
  assert.equal(r.triplas.length, ctx.nivel.C.triplas);
  const ordenes = new Set(r.filas.filter((f) => f.tripla === 0).map((f) => f.orden.join('|')));
  assert.equal(ordenes.size, 6);
  const sinPermutar = await correr(C, { nivel: nivelChico({ C: { triplas: 4, repeticiones: 2, permutar: false } }) });
  assert.equal(sinPermutar.llamadas.pick, 4 * 2);
});

test('armarTriplas: tríos de 3 tópicos distintos, sin repetir, y termina aunque falten fuentes', () => {
  const { ctx } = crearFalso();
  const triplas = C.armarTriplas(ctx, 4);
  assert.equal(triplas.length, 4);
  for (const t of triplas) assert.equal(new Set(t.map(norm)).size, 3);
  const claves = triplas.map((t) => t.map(norm).sort().join('|'));
  assert.equal(new Set(claves).size, claves.length);

  const muchas = C.armarTriplas(ctx, 1000);
  assert.ok(muchas.length > 4 && muchas.length < 1000);
  assert.ok(C.armarTriplas(crearFalso({ usuarios: 0 }).ctx, 5).length >= 1);
});

// ================================================================= D: carga
test('D encuentra el escalón donde se degrada y se detiene ahí (o sigue con --seguir-tras-quiebre)', async () => {
  const nivel = nivelChico({ D: { rampa: [1, 2, 4, 8], tareasMin: 4, tareasPorWorker: 1, mega: 8, lock: 4, stampede: 5 } });
  const lenta = { msPorConcurrente: (c) => (c >= 4 ? 100 : 0) };

  const { r } = await correr(D, { nivel, fallas: lenta });
  assert.equal(r.resumen.rampaPick.quiebre, 4);
  assert.equal(hallazgo(r, 'D-QUIEBRE-PICK').severidad, 'ALTA');
  assert.deepEqual(r.datos.pasosPick.map((p) => p.c), [1, 2, 4], 'la rampa se corta en el primer escalón que se quiebra');
  assert.equal(r.resumen.rampaDigest.quiebre, 4);
  assert.ok(ids(r).includes('D-QUIEBRE-DIGEST'));

  const seguir = crearFalso({ nivel, fallas: lenta });
  seguir.ctx.args['seguir-tras-quiebre'] = true;
  const rs = await D.correr(seguir.ctx);
  assert.deepEqual(rs.datos.pasosPick.map((p) => p.c), [1, 2, 4, 8]);
});

test('D: bajo carga, los errores de búsqueda tragados se ven como hallazgo', async () => {
  const { r } = await correr(D, { fallas: { errorBusquedaCada: 2 } });
  assert.equal(hallazgo(r, 'D-ERRORES-TRAGADOS-PICK').severidad, 'ALTA');
  assert.ok(r.resumen.rampaPick.quiebre !== null, 'más de 10 % de búsquedas fallidas ya cuenta como quiebre');
});

test('D: el candado de digest — sano, roto y que no se libera', async () => {
  const sano = (await correr(D)).r;
  assert.ok(ids(sano).includes('D-LOCK-OK') && ids(sano).includes('D-LOCK-LIBERA'));
  assert.equal(sano.resumen.lock.mismoUsuario.lecturasUsuario, 1);

  const roto = (await correr(D, { fallas: { candadoRoto: true } })).r;
  assert.equal(hallazgo(roto, 'D-LOCK-NO-AGRUPA').severidad, 'ALTA');
  assert.equal(roto.resumen.lock.mismoUsuario.lecturasUsuario, 4);

  const pegado = (await correr(D, { fallas: { candadoNoLibera: true } })).r;
  assert.equal(hallazgo(pegado, 'D-LOCK-NO-LIBERA').severidad, 'CRITICA');
});

test('D: la ráfaga sobre un tópico nuevo cuenta las expansiones de OpenAI', async () => {
  const sinCache = (await correr(D, { fallas: { alBuscar: (c) => { c.openai.chat.llamadas++; } } })).r;
  const h = hallazgo(sinCache, 'D-STAMPEDE-EXPANSION');
  assert.equal(h.severidad, 'MEDIA');
  assert.match(h.titulo, /5 llamadas simultáneas .* 5 expansiones/);
  assert.ok(ids((await correr(D)).r).includes('D-EXPANSION-OK'));
});

test('D sin usuarios: omite los digests y el candado, y lo dice', async () => {
  const sinUsuarios = (await correr(D, { usuarios: 0 })).r;
  assert.equal(sinUsuarios.datos.pasosDigest, null);
  assert.ok(ids(sinUsuarios).includes('D-LOCK-OMITIDO'));
  assert.ok(sinUsuarios.datos.pasosPick.length > 0, 'la rampa de tópicos sí corre');

  const falso = crearFalso();
  falso.ctx.tieneDigest = false;
  falso.ctx.motivoSinDigest = 'se pidió --sin-usuarios';
  const r = await D.correr(falso.ctx);
  assert.match(hallazgo(r, 'D-LOCK-OMITIDO').titulo, /se pidió --sin-usuarios/);
  assert.equal(falso.llamadas.digest, 0);
});

test('D: la llamada gigante y las violaciones de digests quedan medidas', async () => {
  const { r } = await correr(D);
  assert.equal(r.resumen.mega.topics, 8);
  assert.equal(r.resumen.mega.resultados, 8);
  assert.ok(ids(r).includes('D-MEGA-SECUENCIAL'));
  assert.ok(ids(r).includes('D-CAPACIDAD-CRON'));
});

// ================================================================= E: hostiles
test('E manda TODAS las entradas hostiles y todas las variantes de escritura', async () => {
  const { r, llamadas, ctx } = await correr(E);
  const hostiles = hostilesDe('todos');
  assert.equal(r.hostiles.length, hostiles.length * ctx.nivel.E.repeticiones);
  assert.deepEqual([...new Set(r.hostiles.map((h) => h.id))].sort(), hostiles.map((h) => h.id).sort());
  assert.ok(r.variantes.length > 0);
  assert.equal(llamadas.pick, r.hostiles.length + r.variantes.length);
  assert.equal(r.llamadasPlaneadas >= llamadas.pick, true);
  const vacio = r.hostiles.find((h) => h.id === 'vacio');
  assert.equal(vacio.nResultados, 0, 'un tópico vacío no devuelve resultados (igual que producción)');
});

test('E: modo básico usa solo las entradas básicas', async () => {
  const { r } = await correr(E, { nivel: nivelChico({ E: { hostiles: 'basicos', variantes: 1, repeticiones: 2 } }) });
  assert.equal(r.hostiles.length, hostilesDe('basicos').length * 2);
});

test('E detecta una excepción o cuelgue con un texto hostil', async () => {
  const { r } = await correr(E, { fallas: { lanzarPara: [null] } });
  const h = hallazgo(r, 'E-EXCEPCION');
  assert.equal(h.severidad, 'CRITICA');
  assert.match(h.evidencia.join(' '), /null/);
});

test('E detecta búsquedas rotas por el texto (prototipo) y variantes de escritura que se resuelven distinto', async () => {
  const { r } = await correr(E, { fallas: { errorBusquedaPara: ['constructor', 'RIVER PLATE'] } });
  assert.equal(hallazgo(r, 'E-ERROR-BUSQUEDA-PROTOTIPO').severidad, 'BAJA');
  assert.match(hallazgo(r, 'E-ERROR-BUSQUEDA-PROTOTIPO').evidencia.join(' '), /constructor/);
  const v = hallazgo(r, 'E-VARIANTES-CLASE');
  assert.ok(v);
  assert.match(v.evidencia[0], /"river plate".*MAYUSCULAS→rescate/);
});

// ================================================================= F: soak
test('F detecta una fuga de memoria sostenida', async () => {
  let n = 0;
  const memoria = () => ({ rssMB: 100 + n, heapMB: 50 + 30 * n++, externalMB: 1 });
  const { r } = await correr(F, { nivel: nivelChico({ F: { minutos: 0.006, intervaloMs: 25 } }), fallas: { memoria } });
  assert.equal(hallazgo(r, 'F-MEMORIA').severidad, 'ALTA');
  assert.ok(r.resumen.heapMBporMin > 20);
});

// ================================================================= plan vs. realidad
test('el plan de --dry-run coincide con lo que los escenarios hacen de verdad', async () => {
  const nivel = nivelChico();
  const plan = (falso) => tamanios(nivel, {
    oficiales: falso.ctx.temas.oficiales.length, libres: falso.ctx.temas.libres.length, usuarios: 1, hostiles: hostilesDe(nivel.E.hostiles).length,
  });
  for (const [escenario, clave] of [[A, 'A'], [B, 'B'], [C, 'C']]) {
    const falso = crearFalso({ nivel });
    await escenario.correr(falso.ctx);
    const p = plan(falso)[clave];
    assert.equal(falso.llamadas.pick, p.picks, `${clave}: llamadas a pick`);
    assert.equal(falso.llamadas.topicosBuscados, p.busquedas, `${clave}: búsquedas`);
  }
  const d = crearFalso({ nivel });
  await D.correr(d.ctx);
  const pd = plan(d).D;
  assert.equal(d.llamadas.pick, pd.picks, 'D: llamadas a pick');
  assert.equal(d.llamadas.digest, pd.digests, 'D: digests');
  assert.ok(d.llamadas.topicosBuscados <= pd.busquedas, 'D: el plan es una cota superior');

  const e = crearFalso({ nivel });
  await E.correr(e.ctx);
  const pe = plan(e).E;
  assert.ok(e.llamadas.pick <= pe.picks && e.llamadas.pick > 0, 'E: el plan es una cota superior');
});

// ================================================================= cortar la corrida
test('si la corrida se corta (Ctrl+C, tiempo o presupuesto) cada escenario devuelve un parcial sin romperse', async () => {
  const presupuesto = crearPresupuesto(1);
  presupuesto.gastar();
  const control = crearControl({ presupuesto });
  assert.equal(control.detener(), true);
  for (const escenario of [A, B, C, D, E]) {
    const falso = crearFalso({ control });
    const r = await escenario.correr(falso.ctx);
    assert.equal(r.parcial, true, escenario.ID);
    assert.equal(falso.llamadas.pick, 0, `${escenario.ID} no debe seguir llamando`);
    assert.ok(Array.isArray(r.hallazgos), escenario.ID);
  }
  const soak = crearFalso({ control, nivel: nivelChico({ F: { minutos: 0.01, intervaloMs: 20 } }) });
  const rf = await F.correr(soak.ctx);
  assert.equal(soak.llamadas.pick, 0);
  assert.ok(ids(rf).includes('F-CORTO'));
});

test('cortar a mitad de camino conserva lo medido hasta ahí', async () => {
  const control = crearControl();
  const falso = crearFalso({ control });
  const original = falso.ctx.pick;
  let n = 0;
  falso.ctx.pick = async (...a) => { if (++n === 10) control.solicitar('interrumpida con Ctrl+C'); return original(...a); };
  const r = await A.correr(falso.ctx);
  assert.equal(r.parcial, true);
  assert.ok(r.filas.length >= 10 && r.filas.length < r.llamadasPlaneadas, `${r.filas.length} filas de ${r.llamadasPlaneadas}`);
  assert.equal(r.resumen.llamadas, r.filas.length);
});

// ================================================================= el reporte con datos reales de los escenarios
test('el reporte (JSON, HTML, CSV) se arma bien con la salida real de los 6 escenarios', async () => {
  const falso = crearFalso({
    nivel: nivelChico({ F: { minutos: 0.004, intervaloMs: 25 } }),
    fallas: { errorBusquedaCada: 3, casiDuplicados: true, errorBusquedaPara: ['constructor'] },
  });
  const escenarios = [];
  for (const e of ESCENARIOS) {
    const r = await e.correr(falso.ctx);
    if (r) escenarios.push(r);
  }
  assert.deepEqual(escenarios.map((e) => e.id), ['A', 'B', 'C', 'D', 'E', 'F']);

  const contadores = falso.ctx.contar();
  const rep = construirReporte({
    meta: { ...falso.ctx.meta, nivel: 'chico', iniciadoEn: new Date().toISOString(), duracionMin: 0.1, parcial: false, motivoParada: null },
    plan: {}, escenarios, estatico: [], contadores, topErrores: [], globales: hallazgosGlobales({ contadores }), erroresInternos: [],
  });
  assert.ok(rep.hallazgos.length > 5);
  assert.deepEqual(JSON.parse(JSON.stringify(rep)).hallazgos.map((h) => h.id), rep.hallazgos.map((h) => h.id), 'el reporte es serializable sin pérdida');

  const html = htmlReporte(rep);
  for (const id of ['A', 'B', 'C', 'D', 'E', 'F']) assert.ok(html.includes(`id="esc-${id}"`), `falta la sección ${id}`);
  for (const basura of ['undefined', 'NaN', '[object Object]', 'null%']) assert.ok(!html.includes(basura), `el HTML contiene "${basura}"`);
});

// ================================================================= CLI de punta a punta
const URI_FALSA = 'mongodb+srv://usuario:clavesecreta@host.falso.mongodb.net/basefalsa?retryWrites=true';

async function correrCli(argv, { uri = URI_FALSA, falso = {}, interrumpir = false, tty = false } = {}) {
  const salida = [];
  let cerrado = 0;
  const previoUri = process.env.MONGODB_URI;
  const ttyPrevio = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  if (uri === null) delete process.env.MONGODB_URI; else process.env.MONGODB_URI = uri;
  Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
  try {
    const codigo = await main(argv, {
      out: (t = '') => salida.push(String(t)),
      sinSenales: true,
      crearEntorno: async ({ nivel, control }) => {
        if (interrumpir) control.solicitar('interrumpida con Ctrl+C');
        const f = crearFalso({ nivel, control, ...falso });
        return { ctx: f.ctx, cerrar: async () => { cerrado++; } };
      },
    });
    return { codigo, texto: salida.join('\n'), cerrado };
  } finally {
    if (previoUri === undefined) delete process.env.MONGODB_URI; else process.env.MONGODB_URI = previoUri;
    if (ttyPrevio) Object.defineProperty(process.stdin, 'isTTY', ttyPrevio); else delete process.stdin.isTTY;
  }
}

const carpetaTemporal = () => fs.mkdtempSync(path.join(os.tmpdir(), 'estres-cli-'));
const sinEnv = (dir) => path.join(dir, 'no-existe.env'); // evita que el test lea el .env real de quien lo corre

test('CLI: una corrida completa escribe los 4 archivos, imprime el veredicto y no filtra credenciales', async () => {
  const dir = carpetaTemporal();
  try {
    const { codigo, texto, cerrado } = await correrCli(
      ['--nivel', 'suave', '--si', '--solo', 'A,E', '--repeticiones', '1', '--salida', dir, '--env', sinEnv(dir), '--semilla', '5'],
    );
    assert.equal(codigo, 0);
    assert.equal(cerrado, 1, 'cierra el entorno al terminar');
    for (const frag of ['Plan · nivel suave', 'Se va a ejecutar contra host.falso.mongodb.net · base "basefalsa"', '▶ A ·', '▶ E ·', '✔ A:', '✔ E:', 'Veredicto:', 'Hallazgos:']) {
      assert.ok(texto.includes(frag), `falta "${frag}" en la salida`);
    }
    assert.match(texto, /Auditoría estática del código actual: \d+ hallazgo\(s\)( \(\d+ solo informativo\(s\): van en el reporte\))?\./);
    assert.ok(!texto.includes('▶ B') && !texto.includes('▶ D'), 'solo corre lo pedido');
    assert.ok(!/clavesecreta|usuario:/.test(texto), 'la salida no debe mostrar usuario ni contraseña');

    for (const f of ['estres.json', 'hallazgos.csv', 'topicos_A.csv', 'reporte.html']) assert.ok(fs.existsSync(path.join(dir, f)), f);
    const json = fs.readFileSync(path.join(dir, 'estres.json'), 'utf8');
    assert.ok(!/clavesecreta|usuario:|host\.falso/.test(json), 'el JSON no debe tener credenciales ni el host');
    const rep = JSON.parse(json);
    assert.equal(rep.meta.nivel, 'suave');
    assert.deepEqual(rep.meta.escenarios, ['A', 'E']);
    assert.deepEqual(rep.escenarios.map((e) => e.id), ['A', 'E']);
    assert.equal(rep.meta.openaiUsadas, 0);
    assert.equal(rep.meta.parcial, false);
    assert.ok(fs.readFileSync(path.join(dir, 'reporte.html'), 'utf8').startsWith('<!doctype html>'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --dry-run muestra el plan y NO se conecta a nada', async () => {
  let conecto = false;
  const salida = [];
  const codigo = await main(['--nivel', 'medio', '--dry-run'], {
    out: (t = '') => salida.push(String(t)),
    crearEntorno: async () => { conecto = true; throw new Error('no debería conectarse'); },
  });
  const texto = salida.join('\n');
  assert.equal(codigo, 0);
  assert.equal(conecto, false);
  assert.ok(texto.includes('Plan · nivel medio'));
  assert.ok(texto.includes('--dry-run: no se conectó a Mongo ni a OpenAI'));
  assert.ok(!texto.includes('Se va a ejecutar contra'));
  // Es lo primero que se ve al probarlo: nada de celdas rotas en el plan ni en la auditoría estática.
  assert.doesNotMatch(texto, /undefined|NaN|\[object/);
  const estatica = texto.match(/Auditoría estática del código actual: (\d+) hallazgo\(s\)(?: \((\d+) solo informativo)?/);
  assert.ok(estatica, 'imprime la auditoría estática');
  const mostrados = (texto.match(/^    [🔴🟠🟡🔵⚪] /gmu) || []).length;
  assert.equal(mostrados + Number(estatica[2] || 0), Number(estatica[1]), 'los hallazgos mostrados + los informativos = el total anunciado');
});

test('CLI: --ayuda imprime la ayuda y sale', async () => {
  const salida = [];
  assert.equal(await main(['--ayuda'], { out: (t = '') => salida.push(String(t)) }), 0);
  assert.ok(salida.join('\n').includes('Test de estrés 3Minutos'));
  assert.ok(salida.join('\n').includes('--seguir-tras-quiebre'));
});

test('CLI: sin MONGODB_URI, sin confirmación o con argumentos inválidos, falla antes de tocar nada', async () => {
  const dir = carpetaTemporal();
  try {
    await assert.rejects(correrCli(['--si', '--env', sinEnv(dir)], { uri: null }), /Falta MONGODB_URI/);
    await assert.rejects(correrCli(['--env', sinEnv(dir)]), /No hay terminal interactiva/);
    await assert.rejects(correrCli(['--solo', 'Z', '--dry-run']), /Escenario desconocido: Z/);
    await assert.rejects(correrCli(['--nivel', 'nada', '--dry-run']), /Nivel desconocido/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: Ctrl+C deja un reporte parcial, con el motivo, y cierra el entorno', async () => {
  const dir = carpetaTemporal();
  try {
    const { codigo, texto, cerrado } = await correrCli(
      ['--si', '--solo', 'A,B', '--salida', dir, '--env', sinEnv(dir)], { interrumpir: true },
    );
    assert.equal(codigo, 0);
    assert.equal(cerrado, 1);
    assert.ok(texto.includes('⏭  A omitido (interrumpida con Ctrl+C)'));
    assert.ok(texto.includes('PARCIAL'));
    const rep = JSON.parse(fs.readFileSync(path.join(dir, 'estres.json'), 'utf8'));
    assert.equal(rep.meta.parcial, true);
    assert.equal(rep.meta.motivoParada, 'interrumpida con Ctrl+C');
    assert.ok(rep.hallazgos.some((h) => h.id === 'G-PARCIAL'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: un bug interno de un escenario no tira la corrida: queda como hallazgo X-ERROR-DEL-TEST', async () => {
  const dir = carpetaTemporal();
  const original = A.correr;
  A.correr = async () => { throw new Error('bug simulado'); };
  try {
    const { codigo, texto } = await correrCli(['--si', '--solo', 'A,E', '--salida', dir, '--env', sinEnv(dir)]);
    assert.equal(codigo, 0);
    assert.ok(texto.includes('✖ A se cortó por un error del propio test: bug simulado'));
    assert.ok(texto.includes('✔ E:'), 'los demás escenarios siguen');
    const rep = JSON.parse(fs.readFileSync(path.join(dir, 'estres.json'), 'utf8'));
    const h = rep.hallazgos.find((x) => x.id === 'X-ERROR-DEL-TEST');
    assert.equal(h.severidad, 'ALTA');
    assert.match(h.titulo, /bug simulado/);
  } finally {
    A.correr = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: si el test llegara a escribir en Mongo, el reporte lo marca como CRÍTICO (veredicto ROJO)', async () => {
  const dir = carpetaTemporal();
  try {
    const { texto } = await correrCli(
      ['--si', '--solo', 'A', '--repeticiones', '1', '--salida', dir, '--env', sinEnv(dir)],
      { falso: { fallas: { alBuscar: (c) => { c.mongo.escrituras = 1; } } } },
    );
    assert.ok(texto.includes('Veredicto: ROJO'));
    const rep = JSON.parse(fs.readFileSync(path.join(dir, 'estres.json'), 'utf8'));
    assert.equal(rep.hallazgos[0].id, 'G-ESCRITURAS');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
