'use strict';

/**
 * Tests de los analizadores del test de estrés (escenarios A–F, globales y auditoría estática).
 * Cada hallazgo se prueba con filas inventadas: se arma el problema a mano y se comprueba que
 * el analizador lo detecta (y que NO inventa problemas cuando todo está bien).
 *   npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { analizarRepeticiones, analizarSesiones, notasDeSesion } = require('../estres/analisis_ab');
const { analizarMultitopico, analizarHostiles, analizarVariantes, analizarSoak, ordenDependiente } = require('../estres/analisis_cef');
const D = require('../estres/analisis_d');
const { auditarFuentes, leerFuentes, ARCHIVOS } = require('../estres/estatico');
const path = require('path');

const ids = (r) => (Array.isArray(r) ? r : r.hallazgos).map((h) => h.id);
const hallazgo = (r, id) => (Array.isArray(r) ? r : r.hallazgos).find((h) => h.id === id);
const viol = (id, severidad = 'ALTA', topic = 't') => ({ id, severidad, topic, mensaje: 'm' });

const art = (id, extra = {}) => ({
  // El título lleva palabras únicas por nota (de ≥3 letras): si no, el chequeo de "casi duplicados" las tomaría por la misma historia.
  id, url: `https://x.test/${id}`, titulo: `Nota ${id} caso${id} tema${id}`, categoria: 'Deportes', subtema: 'Fútbol',
  fuente: 'Ole', edadHoras: 3, score: 0.97, finalScore: 80, ...extra,
});

// ================================================================= A
let reloj = 0;
const filaA = (tema, id, o = {}) => ({
  t: reloj++, tema, tipo: 'libre', nivel: 'libre', categoria: null, rep: 1, ms: 100, error: null, timeout: false,
  clase: id ? 'tema' : 'vacio', zona: id ? 'VERDE' : null, motivo: id ? 'VERDE score=0.97' : 'sin_candidatos', corral: null, candidatos: 3,
  art: id ? art(id) : null, menciona: true, violaciones: [], logs: null, ...o,
});
const rescateA = (tema, id, o = {}) => filaA(tema, id, { clase: 'rescate', zona: 'RESCATE', motivo: 'ningun_candidato_valido', ...o });

test('A: tópicos estables no generan hallazgos', () => {
  const r = analizarRepeticiones([filaA('river', 'n1'), filaA('river', 'n1'), filaA('river', 'n1'), filaA('boca', 'n2'), filaA('boca', 'n2')]);
  assert.deepEqual(r.hallazgos, []);
  assert.equal(r.resumen.llamadas, 5);
  assert.equal(r.resumen.topicos, 2);
  assert.equal(r.resumen.pctEstables, 100);
  assert.equal(r.porTema.find((t) => t.tema === 'river').pctModal, 100);
  assert.deepEqual(r.resumen.clases, { tema: 5 });
  assert.deepEqual(r.resumen.porTipo.libre, { topicos: 2, conNota: 2, rescate: 0 });
});

test('A: ir y volver entre notas es FLAPPING; un cambio único es solo informativo', () => {
  const flap = analizarRepeticiones([filaA('river', 'n1'), filaA('river', 'n2'), filaA('river', 'n1')]);
  assert.equal(hallazgo(flap, 'A-FLAPPING').severidad, 'ALTA');
  assert.ok(!ids(flap).includes('A-CAMBIO-UNICO'));
  assert.equal(flap.porTema[0].transiciones, 2);
  assert.equal(flap.resumen.pctEstables, 0);

  const unico = analizarRepeticiones([filaA('river', 'n1'), filaA('river', 'n1'), filaA('river', 'n2')]);
  assert.equal(hallazgo(unico, 'A-CAMBIO-UNICO').severidad, 'BAJA');
  assert.ok(!ids(unico).includes('A-FLAPPING'));
});

test('A: tema a veces, rescate otras veces con la misma entrada', () => {
  const r = analizarRepeticiones([filaA('river', 'n1'), rescateA('river', 'r1'), filaA('river', 'n1')]);
  const h = hallazgo(r, 'A-RESCATE-INTERMITENTE');
  assert.equal(h.severidad, 'ALTA');
  assert.match(h.evidencia[0], /"river": rescate en 1\/3/);
  const siempreRescate = analizarRepeticiones([rescateA('river', 'r1'), rescateA('river', 'r1')]);
  assert.ok(!ids(siempreRescate).includes('A-RESCATE-INTERMITENTE'), 'consistente = no es intermitente');
});

test('A: un error de búsqueda disfrazado de "noticia sugerida" es ALTA', () => {
  const r = analizarRepeticiones([filaA('river', 'n1'), rescateA('river', 'r1', { motivo: 'error_busqueda' })]);
  const h = hallazgo(r, 'A-ERROR-BUSQUEDA-TRAGADO');
  assert.equal(h.severidad, 'ALTA');
  assert.match(h.evidencia[0], /1\/2/);
});

test('A: llamadas con error o timeout', () => {
  const r = analizarRepeticiones([filaA('river', null, { clase: 'error', error: 'boom' }), filaA('river', null, { clase: 'error', timeout: true, error: 'timeout de 5 ms' }), filaA('river', 'n1')]);
  assert.equal(hallazgo(r, 'A-ERRORES').severidad, 'ALTA');
  assert.match(hallazgo(r, 'A-ERRORES').evidencia[0], /2\/3/);
  assert.equal(r.porTema[0].errores, 2);
});

test('A: la misma nota para 3 o más tópicos distintos (rescate "monocultivo")', () => {
  const tres = analizarRepeticiones(['a', 'b', 'c'].map((t) => rescateA(t, 'hub')));
  assert.equal(hallazgo(tres, 'A-NOTA-REPETIDA-ENTRE-TEMAS').severidad, 'MEDIA');
  assert.match(hallazgo(tres, 'A-NOTA-REPETIDA-ENTRE-TEMAS').evidencia[0], /3 tópicos \(rescate\)/);
  const dos = analizarRepeticiones(['a', 'b'].map((t) => rescateA(t, 'hub')));
  assert.ok(!ids(dos).includes('A-NOTA-REPETIDA-ENTRE-TEMAS'), 'con 2 todavía es tolerable');
});

test('A: demasiados tópicos libres terminan en rescate (umbral 35 %)', () => {
  const mitad = analizarRepeticiones([rescateA('a', 'r1'), rescateA('b', 'r2'), filaA('c', 'n3'), filaA('d', 'n4')]);
  assert.equal(hallazgo(mitad, 'A-RESCATE-ALTO-LIBRES').severidad, 'MEDIA');
  const cuarto = analizarRepeticiones([rescateA('a', 'r1'), filaA('b', 'n2'), filaA('c', 'n3'), filaA('d', 'n4')]);
  assert.ok(!ids(cuarto).includes('A-RESCATE-ALTO-LIBRES'));
  const vaciosCuentan = analizarRepeticiones([filaA('a', null), filaA('b', null), filaA('c', 'n3')]);
  assert.ok(ids(vaciosCuentan).includes('A-RESCATE-ALTO-LIBRES'), 'vacío cuenta como falla del tópico');
});

test('A: categorías y subtemas oficiales sin nota propia', () => {
  const cat = { tipo: 'oficial', nivel: 'categoria', categoria: 'Deportes' };
  const sub = { tipo: 'oficial', nivel: 'subtema', categoria: 'Deportes' };
  const r = analizarRepeticiones([rescateA('Deportes', 'r1', cat), rescateA('Tenis', 'r2', sub), filaA('Política', 'n3', { tipo: 'oficial', nivel: 'categoria', categoria: 'Política' })]);
  assert.equal(hallazgo(r, 'A-CATEGORIA-SIN-NOTA').severidad, 'ALTA');
  assert.match(hallazgo(r, 'A-CATEGORIA-SIN-NOTA').evidencia[0], /"Deportes"/);
  assert.equal(r.porTema.filter((t) => t.tipo === 'oficial').length, 3);
  assert.equal(hallazgo(r, 'A-SUBTEMA-SIN-NOTA').severidad, 'MEDIA');
  assert.match(hallazgo(r, 'A-SUBTEMA-SIN-NOTA').evidencia[0], /"Tenis" \(Deportes\)/);
});

test('A: sin noticia, VERDE sin mención y lentitud', () => {
  const r = analizarRepeticiones([
    filaA('vacio', null),
    filaA('verde', 'n1', { menciona: false }),
    filaA('lento', 'n2', { ms: 40000 }),
  ], { timeoutS: 60 });
  assert.equal(hallazgo(r, 'A-SIN-NOTICIA').severidad, 'MEDIA');
  assert.equal(hallazgo(r, 'A-VERDE-SIN-MENCION').severidad, 'BAJA');
  assert.equal(hallazgo(r, 'A-LENTO').severidad, 'MEDIA');
  assert.match(hallazgo(r, 'A-LENTO').evidencia[0], /"lento": p95 40000 ms/);
  const rapido = analizarRepeticiones([filaA('lento', 'n2', { ms: 20000 })], { timeoutS: 60 });
  assert.ok(!ids(rapido).includes('A-LENTO'), '20 s con timeout de 60 s no es lento');
});

test('A: las violaciones de invariantes se convierten en hallazgos del escenario', () => {
  const r = analizarRepeticiones([filaA('river', 'n1', { violaciones: [viol('I1-EDAD', 'ALTA', 'river')] }), filaA('river', 'n1')]);
  assert.equal(hallazgo(r, 'A-I1-EDAD').severidad, 'ALTA');
  assert.equal(r.porTema[0].violaciones, 1);
});

// ================================================================= B
const rondaB = (tema, ronda, clase, o = {}) => ({ tema, tipo: 'libre', ronda, clase, ms: 100, error: null, timeout: false, violaciones: [], ...o });
const sesionB = (sesion, ronda, notas, o = {}) => ({
  sesion, ronda, ms: 100, error: null, timeout: false, reaparecidas: [], violaciones: [],
  resultados: notas.map((a) => ({ topic: 't', clase: 'tema', art: a })), ...o,
});

test('B: entrada vacía no rompe', () => {
  const r = analizarSesiones({});
  assert.deepEqual(r.hallazgos, []);
  assert.equal(r.resumen.temas, 0);
  assert.equal(r.resumen.rondasPorTema, 0);
});

test('B: un tópico que llega a vacío tras refrescos repetidos', () => {
  const r = analizarSesiones({ rondasTema: [rondaB('river', 1, 'tema'), rondaB('river', 2, 'rescate'), rondaB('river', 3, 'vacio')] });
  const h = hallazgo(r, 'B-SIN-NOTICIA');
  assert.equal(h.severidad, 'MEDIA');
  assert.match(h.evidencia[0], /vacío desde la ronda 3/);
  assert.equal(r.porTema[0].primeraRescate, 2);
});

test('B: agotamiento rápido de tópicos libres es solo informativo', () => {
  const agotado = analizarSesiones({ rondasTema: [rondaB('river', 1, 'tema'), rondaB('river', 2, 'rescate'), rondaB('river', 3, 'rescate')] });
  assert.equal(hallazgo(agotado, 'B-AGOTAMIENTO-RAPIDO').severidad, 'INFO');
  const sano = analizarSesiones({ rondasTema: [rondaB('river', 1, 'tema'), rondaB('river', 2, 'tema'), rondaB('river', 3, 'rescate')] });
  assert.ok(!ids(sano).includes('B-AGOTAMIENTO-RAPIDO'));
});

test('B: repetir una nota dentro de la ventana es CRÍTICO (I7) y se cuenta por tópico', () => {
  const r = analizarSesiones({ rondasTema: [rondaB('river', 1, 'tema'), rondaB('river', 2, 'tema', { violaciones: [viol('I7-REPETIDO-HISTORIAL', 'CRITICA', 'river')] })] });
  assert.equal(hallazgo(r, 'B-I7-REPETIDO-HISTORIAL').severidad, 'CRITICA');
  assert.equal(r.porTema[0].repetidas, 1);
});

test('B: una nota que vuelve después de salir del tope del historial', () => {
  const reaparecida = { url: 'https://x.test/n1', titulo: 'Nota n1', rondaPrevia: 1, ronda: 12 };
  const r = analizarSesiones({ sesiones: [sesionB(1, 1, [art('n1')]), sesionB(1, 12, [art('n9')], { reaparecidas: [reaparecida] })] });
  const h = hallazgo(r, 'B-REAPARICION');
  assert.equal(h.severidad, 'ALTA');
  assert.match(h.evidencia[0], /sesión 1: "Nota n1" \(la primera vez, ronda 1\)/);
  assert.equal(r.resumen.reaparecidas, 1);
  assert.equal(r.resumen.sesiones, 1);
  assert.equal(r.resumen.rondasSesion, 2);
});

test('B: notas casi iguales dentro de una sesión (por títulos, y por embeddings si hay)', () => {
  const a = art('n1', { titulo: 'Boca ganó el clásico en La Bombonera' });
  const b = art('n2', { titulo: 'Boca ganó el clásico en la Bombonera hoy' });
  const mismaSesion = [sesionB(1, 1, [a]), sesionB(1, 2, [b])];

  const porTitulo = analizarSesiones({ sesiones: mismaSesion });
  assert.equal(hallazgo(porTitulo, 'B-CASI-DUPLICADOS').severidad, 'MEDIA');
  assert.equal(porTitulo.resumen.paresCasiDuplicados, 1);
  assert.equal(porTitulo.resumen.paresPorCoseno, 0);

  const porVector = analizarSesiones({ sesiones: mismaSesion, vectores: new Map([['n1', [1, 0]], ['n2', [1, 0.01]]]) });
  assert.equal(hallazgo(porVector, 'B-CASI-DUPLICADOS').severidad, 'ALTA');
  assert.equal(porVector.resumen.paresPorCoseno, 1);

  const sesionesDistintas = analizarSesiones({ sesiones: [sesionB(1, 1, [a]), sesionB(2, 1, [b])] });
  assert.ok(!ids(sesionesDistintas).includes('B-CASI-DUPLICADOS'), 'dos usuarios distintos pueden ver notas parecidas');
});

test('B: notasDeSesion junta las notas en orden y descarta las vacías', () => {
  const filas = [sesionB(1, 1, [art('n1'), null]), sesionB(1, 2, [art('n2')])];
  assert.deepEqual(notasDeSesion(filas).map((n) => n.id), ['n1', 'n2']);
});

// ================================================================= C
const filaC = (tripla, orden, items, o = {}) => ({
  t: 0, tripla, orden, rep: 1, ms: 100, error: null, timeout: false, violaciones: [], logs: null,
  resultados: items.map(([topic, id, clase = 'tema', extra = {}]) => ({ topic, clase, zona: 'VERDE', motivo: 'm', art: id ? art(id, extra) : null })),
  ...o,
});

test('C: un digest de 3 tópicos sano no genera hallazgos', () => {
  const r = analizarMultitopico([filaC(0, ['a', 'b', 'c'], [['a', 'n1'], ['b', 'n2'], ['c', 'n3']])]);
  assert.deepEqual(r.hallazgos, []);
  assert.equal(r.resumen.llamadas, 1);
  assert.equal(r.resumen.porPosicion.length, 3);
});

test('C: dos notas de la misma historia en el mismo digest', () => {
  const r = analizarMultitopico([filaC(0, ['a', 'b', 'c'], [
    ['a', 'n1', 'tema', { titulo: 'Boca ganó el clásico en La Bombonera' }],
    ['b', 'n2', 'tema', { titulo: 'Boca ganó el clásico en la Bombonera hoy' }],
    ['c', 'n3'],
  ])]);
  const h = hallazgo(r, 'C-CASI-DUPLICADOS-EN-LLAMADA');
  assert.equal(h.severidad, 'MEDIA');
  assert.match(h.evidencia[0], /\[a \+ b \+ c\] titulos/);
  assert.equal(r.resumen.llamadasConCasiDuplicados, 1);
});

test('C: el resultado de un tópico depende de su posición en la lista', () => {
  const filas = [
    filaC(0, ['a', 'b', 'c'], [['a', 'n1'], ['b', 'n2'], ['c', 'n3']]),
    filaC(0, ['b', 'a', 'c'], [['b', 'n2'], ['a', 'n9'], ['c', 'n3']]),
  ];
  const dep = ordenDependiente(filas);
  assert.equal(dep.length, 1);
  assert.equal(dep[0].tema, 'a');
  assert.deepEqual(dep[0].modalPorOrden.map((x) => x.posicion).sort(), [1, 2]);

  const r = analizarMultitopico(filas);
  assert.equal(hallazgo(r, 'C-DEPENDE-DEL-ORDEN').severidad, 'MEDIA');
  assert.match(hallazgo(r, 'C-DEPENDE-DEL-ORDEN').evidencia[0], /"a": pos 1 .* \| pos 2/);

  const igual = analizarMultitopico([
    filaC(0, ['a', 'b', 'c'], [['a', 'n1'], ['b', 'n2'], ['c', 'n3']]),
    filaC(0, ['b', 'a', 'c'], [['b', 'n2'], ['a', 'n1'], ['c', 'n3']]),
  ]);
  assert.ok(!ids(igual).includes('C-DEPENDE-DEL-ORDEN'));
  assert.deepEqual(ordenDependiente([filaC(0, ['a', 'b', 'c'], [['a', 'n1'], ['b', 'n2'], ['c', 'n3']])]), [], 'con un solo orden no hay con qué comparar');
});

test('C: el 3.er tópico cae en rescate mucho más que el 1.º', () => {
  const filas = [1, 2, 3, 4].map((i) => filaC(i, ['a', 'b', 'c'], [['a', `x${i}`], ['b', `y${i}`], ['c', `z${i}`, 'rescate']]));
  const r = analizarMultitopico(filas);
  assert.equal(hallazgo(r, 'C-POSICION-PENALIZADA').severidad, 'MEDIA');
  assert.equal(r.resumen.porPosicion[2].rescate, 100);
  assert.equal(r.resumen.porPosicion[0].rescate, 0);
  assert.deepEqual(r.resumen.rescatesPorLlamada, { 1: 4 });
});

test('C: llamadas con error', () => {
  const r = analizarMultitopico([filaC(0, ['a', 'b', 'c'], [], { error: 'boom' })]);
  assert.equal(hallazgo(r, 'C-ERRORES').severidad, 'ALTA');
  assert.match(hallazgo(r, 'C-ERRORES').evidencia[0], /boom/);
});

// ================================================================= E
const hostil = (id, grupo, o = {}) => ({
  id, grupo, valorDesc: JSON.stringify(id), clase: 'vacio', motivo: 'sin_candidatos', ms: 100,
  error: null, timeout: false, lanzo: false, violaciones: [], ...o,
});
const variante = (base, varianteId, clase, url = null) => ({ base, varianteId, clase, url, ms: 100, error: null, violaciones: [] });

test('E: entradas hostiles bien manejadas no generan hallazgos', () => {
  const r = analizarHostiles({ hostiles: [hostil('vacio', 'vacios'), hostil('emoji', 'unicode', { clase: 'rescate', motivo: 'ningun_candidato_valido' })] });
  assert.deepEqual(r.hallazgos, []);
  assert.equal(r.resumen.hostiles, 2);
  assert.deepEqual(r.resumen.clasesPorGrupo, { vacios: { vacio: 1 }, unicode: { rescate: 1 } });
});

test('E: una excepción o un cuelgue con un texto de usuario es CRÍTICO', () => {
  const lanza = analizarHostiles({ hostiles: [hostil('null', 'no_string', { lanzo: true, error: "Cannot read properties of null" })] });
  assert.equal(hallazgo(lanza, 'E-EXCEPCION').severidad, 'CRITICA');
  assert.match(hallazgo(lanza, 'E-EXCEPCION').evidencia[0], /null .*Cannot read properties/);
  const cuelga = analizarHostiles({ hostiles: [hostil('largo_5000', 'extremos', { timeout: true, error: 'timeout de 60000 ms' })] });
  assert.equal(hallazgo(cuelga, 'E-EXCEPCION').severidad, 'CRITICA');
});

test('E: la búsqueda rota por el texto se informa por grupo, con la severidad del grupo', () => {
  const r = analizarHostiles({
    hostiles: [
      hostil('constructor', 'prototipo', { motivo: 'error_busqueda', clase: 'rescate' }),
      hostil('mongo_operador', 'inyeccion', { motivo: 'error_busqueda', clase: 'rescate' }),
      hostil('vacio', 'vacios', { motivo: 'error_busqueda', clase: 'rescate' }),
    ],
  });
  assert.equal(hallazgo(r, 'E-ERROR-BUSQUEDA-PROTOTIPO').severidad, 'BAJA');
  assert.match(hallazgo(r, 'E-ERROR-BUSQUEDA-PROTOTIPO').sugerencia, /Map|hasOwn/);
  assert.equal(hallazgo(r, 'E-ERROR-BUSQUEDA-INYECCION').severidad, 'MEDIA');
  assert.equal(hallazgo(r, 'E-ERROR-BUSQUEDA-VACIOS').severidad, 'INFO');
});

test('E: lentitud con entradas hostiles', () => {
  const r = analizarHostiles({ hostiles: [hostil('largo_5000', 'extremos', { ms: 40000 })] }, { timeoutS: 60 });
  assert.equal(hallazgo(r, 'E-LENTO').severidad, 'MEDIA');
});

test('E: variantes de escritura que se resuelven distinto', () => {
  const claseDistinta = [variante('river', 'original', 'tema', 'u1'), variante('river', 'MAYUSCULAS', 'rescate', 'u2')];
  const r = analizarHostiles({ variantes: claseDistinta });
  assert.equal(hallazgo(r, 'E-VARIANTES-CLASE').severidad, 'MEDIA', '1 de 1 = 100 %');
  assert.match(hallazgo(r, 'E-VARIANTES-CLASE').evidencia[0], /original→tema, MAYUSCULAS→rescate/);

  const pocos = [...claseDistinta, ...Array.from({ length: 9 }, (_, i) => variante(`b${i}`, 'original', 'tema', `u${i}`))];
  assert.equal(hallazgo(analizarHostiles({ variantes: pocos }), 'E-VARIANTES-CLASE').severidad, 'BAJA', '1 de 10 = 10 %');

  const notaDistinta = analizarHostiles({ variantes: [variante('boca', 'original', 'tema', 'u1'), variante('boca', 'minusculas', 'tema', 'u2')] });
  assert.equal(hallazgo(notaDistinta, 'E-VARIANTES-NOTA').severidad, 'BAJA');
  assert.ok(!ids(notaDistinta).includes('E-VARIANTES-CLASE'));

  const igual = analizarHostiles({ variantes: [variante('boca', 'original', 'tema', 'u1'), variante('boca', 'minusculas', 'tema', 'u1')] });
  assert.deepEqual(igual.hallazgos, []);
  assert.deepEqual(analizarVariantes([variante('x', 'original', 'vacio')]).map((b) => [b.base, b.variantes, b.clasesDistintas]), [['x', 1, false]]);
});

// ================================================================= F
const muestra = (i, o = {}) => ({ minuto: i * 0.25, heapMB: 100, rssMB: 200, lagP99: 1, tareas: 10, errores: 0, p95: 100, ...o });
const serie = (n, f) => Array.from({ length: n }, (_, i) => muestra(i, f(i)));

test('F: con pocas muestras no se concluye nada', () => {
  const r = analizarSoak([muestra(0), muestra(1)]);
  assert.deepEqual(ids(r), ['F-CORTO']);
  assert.equal(r.hallazgos[0].severidad, 'INFO');
});

test('F: un soak estable no genera hallazgos', () => {
  const r = analizarSoak(serie(12, () => ({})));
  assert.deepEqual(r.hallazgos, []);
  assert.equal(r.resumen.heapMBporMin, 0);
  assert.equal(r.resumen.muestras, 12);
});

test('F: crecimiento sostenido de memoria (alto, leve, umbral configurable, sin contar el calentamiento)', () => {
  const fuga = analizarSoak(serie(12, (i) => ({ heapMB: 100 + i * 10 })));
  assert.equal(hallazgo(fuga, 'F-MEMORIA').severidad, 'ALTA');
  assert.equal(fuga.resumen.heapMBporMin, 40);

  const leve = analizarSoak(serie(12, (i) => ({ heapMB: 100 + i * 2.5 })));
  assert.equal(hallazgo(leve, 'F-MEMORIA-LEVE').severidad, 'MEDIA');
  assert.ok(!ids(leve).includes('F-MEMORIA'));

  const estricto = analizarSoak(serie(12, (i) => ({ heapMB: 100 + i * 2.5 })), { memoriaMBporMin: 5 });
  assert.ok(ids(estricto).includes('F-MEMORIA'));

  const picoInicial = analizarSoak(serie(12, (i) => ({ heapMB: i < 2 ? 500 : 100 })));
  assert.ok(!ids(picoInicial).includes('F-MEMORIA'), 'el primer 20 % es calentamiento');
});

test('F: degradación de latencia y errores que crecen con el tiempo', () => {
  const lenta = analizarSoak(serie(12, (i) => ({ p95: i < 4 ? 100 : i >= 8 ? 2000 : 500 })));
  assert.equal(hallazgo(lenta, 'F-DEGRADACION').severidad, 'ALTA');
  assert.equal(lenta.resumen.p95Inicio, 100);
  assert.equal(lenta.resumen.p95Final, 2000);

  const leve = analizarSoak(serie(12, (i) => ({ p95: i >= 8 ? 140 : 100 })));
  assert.ok(!ids(leve).includes('F-DEGRADACION'), '40 ms de diferencia no es degradación');

  const errores = analizarSoak(serie(12, (i) => ({ errores: i >= 8 ? 5 : 0 })));
  assert.equal(hallazgo(errores, 'F-ERRORES-CRECEN').severidad, 'MEDIA');
  assert.equal(errores.resumen.tasaErrorInicio, 0);
  assert.equal(errores.resumen.tasaErrorFinal, 50);
});

// ================================================================= D: rampa
const cero = () => ({ llamadas: 0, ok: 0, err429: 0, err5xx: 0, errTimeout: 0, errOtros: 0, bloqueadas: 0, unicos: 0 });
const delta = (sobre = {}) => ({
  openai: { chat: { ...cero(), ...(sobre.chat || {}) }, embeddings: { ...cero(), ...(sobre.embeddings || {}) } },
  mongo: { comandos: 0, fallos: 0, escrituras: 0, bloqueadas: 0, checkOutFallidos: 0, porComando: {}, ...(sobre.mongo || {}) },
});
const paso = (c, o = {}) => ({
  c, tareas: 10, duracionMs: 1000, errores: 0, timeouts: 0, erroresBusqueda: 0, rescates: 0, vacios: 0,
  ms: Array(10).fill(100), violaciones: [], lagP99: 5, rssMB: 200, heapMB: 100, delta: delta(), ...o,
});

test('D: una rampa sana no se quiebra y calcula el throughput', () => {
  const r = D.analizarRampa([paso(1), paso(2), paso(4)]);
  assert.equal(r.quiebre, null);
  assert.deepEqual(ids(r), ['D-SIN-QUIEBRE-PICK']);
  assert.equal(hallazgo(r, 'D-SIN-QUIEBRE-PICK').severidad, 'INFO');
  assert.equal(r.filas.length, 3);
  assert.equal(r.filas[0].throughput, 10);
  assert.equal(r.filas[0].p95, 100);
  assert.deepEqual(D.analizarRampa([]), { filas: [], quiebre: null, hallazgos: [] });
});

test('D: la rampa se quiebra por errores, por latencia contra el timeout, por degradación y por el event loop', () => {
  const porErrores = D.analizarRampa([paso(1), paso(2), paso(4, { errores: 2 })]);
  assert.equal(porErrores.quiebre, 4);
  assert.equal(hallazgo(porErrores, 'D-QUIEBRE-PICK').severidad, 'ALTA');
  assert.match(porErrores.filas[2].motivos[0], /errores 20 %/);
  assert.ok(!ids(porErrores).includes('D-SIN-QUIEBRE-PICK'));

  const justo = D.analizarRampa([paso(1), paso(2, { errores: 1 })]);
  assert.equal(justo.quiebre, 2, '10 % justo ya cuenta como quiebre');

  const porTimeout = D.analizarRampa([paso(1, { ms: Array(10).fill(31000) })], { timeoutS: 60 });
  assert.equal(porTimeout.quiebre, 1);
  assert.match(porTimeout.filas[0].motivos[0], /p95 31000 ms/);

  const porDegradacion = D.analizarRampa([paso(1), paso(2, { ms: Array(10).fill(500) })]);
  assert.equal(porDegradacion.quiebre, 2);
  assert.match(porDegradacion.filas[1].motivos[0], /p95 ×5\.0 vs 1 en paralelo/);
  assert.equal(porDegradacion.filas[1].degradacion, 5);

  const porLoop = D.analizarRampa([paso(1), paso(2, { lagP99: 600 })]);
  assert.equal(porLoop.quiebre, 2);
  assert.match(porLoop.filas[1].motivos[0], /event loop 600 ms/);
});

test('D: lag moderado del event loop sin quiebre es MEDIA; con quiebre no se duplica', () => {
  const r = D.analizarRampa([paso(1), paso(2, { lagP99: 300 })]);
  assert.equal(hallazgo(r, 'D-LAG-PICK').severidad, 'MEDIA');
  assert.equal(r.quiebre, null);
  const quiebra = D.analizarRampa([paso(1), paso(2, { lagP99: 800 })]);
  assert.ok(!ids(quiebra).includes('D-LAG-PICK'));
});

test('D: errores de búsqueda tragados bajo carga', () => {
  const r = D.analizarRampa([paso(1), paso(2, { erroresBusqueda: 2 })]);
  const h = hallazgo(r, 'D-ERRORES-TRAGADOS-PICK');
  assert.equal(h.severidad, 'ALTA');
  assert.match(h.titulo, /2 búsqueda/);
  assert.match(h.evidencia[0], /2 en paralelo: 2\/10/);
});

test('D: errores de OpenAI (429 vs el resto) y de Mongo (fallos vs pool)', () => {
  const r = D.analizarRampa([
    paso(1),
    paso(2, { delta: delta({ chat: { err429: 3 }, embeddings: { err429: 1, errTimeout: 2 }, mongo: { fallos: 1, checkOutFallidos: 2 } }) }),
  ]);
  assert.match(hallazgo(r, 'D-OPENAI-429-PICK').titulo, /4 error/);
  assert.equal(hallazgo(r, 'D-OPENAI-429-PICK').severidad, 'ALTA');
  assert.match(hallazgo(r, 'D-OPENAI-429-PICK').evidencia[0], /chat 3, embeddings 1/);
  assert.match(hallazgo(r, 'D-OPENAI-ERRORES-PICK').titulo, /2 error/);
  assert.equal(hallazgo(r, 'D-OPENAI-ERRORES-PICK').severidad, 'MEDIA');
  assert.equal(hallazgo(r, 'D-MONGO-FALLOS-PICK').severidad, 'ALTA');
  assert.equal(hallazgo(r, 'D-MONGO-POOL-PICK').severidad, 'ALTA');
  const limpio = D.analizarRampa([paso(1), paso(2)]);
  for (const id of ['D-OPENAI-429-PICK', 'D-OPENAI-ERRORES-PICK', 'D-MONGO-FALLOS-PICK', 'D-MONGO-POOL-PICK']) assert.ok(!ids(limpio).includes(id));
});

test('D: la rampa de digests estima la capacidad de la cron y usa su propia etiqueta', () => {
  const r = D.analizarRampa([paso(1), paso(2)], { etiqueta: 'digest' });
  assert.ok(ids(r).includes('D-SIN-QUIEBRE-DIGEST'));
  const cron = hallazgo(r, 'D-CAPACIDAD-CRON');
  assert.equal(cron.severidad, 'INFO');
  assert.match(cron.titulo, /≈600 digests por minuto/);
  assert.match(cron.detalle, /1\.000 usuarios .* ≈2 min/);
  assert.ok(!ids(D.analizarRampa([paso(1)], { etiqueta: 'pick' })).includes('D-CAPACIDAD-CRON'));
});

test('D: las violaciones de invariantes de la rampa pasan a hallazgos', () => {
  const r = D.analizarRampa([paso(1, { violaciones: [viol('I8-DUPLICADO-LLAMADA', 'CRITICA')] })]);
  assert.equal(hallazgo(r, 'D-I8-DUPLICADO-LLAMADA').severidad, 'CRITICA');
});

// ================================================================= D: candado, ráfaga, llamada gigante
const lockOk = () => ({
  mismoUsuario: { llamadas: 5, resueltas: 5, rechazadas: 0, mismosItems: true, lecturasUsuario: 1 },
  usuarioInexistente: { llamadas: 5, resueltas: 0, rechazadas: 5, lecturasUsuario: 1, reintento: { lecturasAntes: 1, lecturasDespues: 2 } },
});

test('D candado: funciona y se libera tras un error', () => {
  const r = D.analizarLock(lockOk());
  assert.deepEqual(r.map((h) => h.id).sort(), ['D-LOCK-LIBERA', 'D-LOCK-OK']);
  assert.ok(r.every((h) => h.severidad === 'INFO'));
  assert.deepEqual(D.analizarLock(null), []);
});

test('D candado: no agrupa, resultados distintos, no libera, resuelve un usuario inexistente', () => {
  const rota = lockOk();
  rota.mismoUsuario.lecturasUsuario = 5;
  rota.mismoUsuario.mismosItems = false;
  rota.usuarioInexistente.resueltas = 2;
  rota.usuarioInexistente.reintento = { lecturasAntes: 6, lecturasDespues: 6 };
  const r = D.analizarLock(rota);
  assert.equal(hallazgo(r, 'D-LOCK-NO-AGRUPA').severidad, 'ALTA');
  assert.match(hallazgo(r, 'D-LOCK-NO-AGRUPA').titulo, /5 generaciones .* 5 ejecuciones/);
  assert.equal(hallazgo(r, 'D-LOCK-RESULTADOS-DISTINTOS').severidad, 'ALTA');
  assert.equal(hallazgo(r, 'D-LOCK-INEXISTENTE-RESUELVE').severidad, 'ALTA');
  assert.equal(hallazgo(r, 'D-LOCK-NO-LIBERA').severidad, 'CRITICA');
  for (const id of ['D-LOCK-OK', 'D-LOCK-LIBERA']) assert.ok(!ids(r).includes(id));
  assert.deepEqual(ids(D.analizarLock({ motivoOmitido: 'se pidió --sin-usuarios' })), ['D-LOCK-OMITIDO']);
});

test('D ráfaga: cuántas expansiones paga un tópico nuevo pedido a la vez', () => {
  const mal = D.analizarStampede({ concurrentes: 5, tema: 'x', ms: 10, llamadasChat: 5, llamadasEmbedding: 5, errores: 0 });
  assert.equal(mal[0].id, 'D-STAMPEDE-EXPANSION');
  assert.equal(mal[0].severidad, 'MEDIA');
  assert.match(mal[0].titulo, /5 llamadas simultáneas .* 5 expansiones/);
  const bien = D.analizarStampede({ concurrentes: 5, tema: 'x', ms: 10, llamadasChat: 1, llamadasEmbedding: 1, errores: 0 });
  assert.equal(bien[0].id, 'D-EXPANSION-OK');
  assert.equal(bien[0].severidad, 'INFO');
  assert.equal(D.analizarStampede({ concurrentes: 5, tema: 'x', ms: 1, llamadasChat: 0, llamadasEmbedding: 1, errores: 0 })[0].id, 'D-EXPANSION-OK');
  assert.deepEqual(D.analizarStampede(null), []);
});

test('D ráfaga: las preguntas de los jueces con IA no cuentan como expansiones', () => {
  // 1 expansión compartida + 3 preguntas del juez de tema: 4 llamadas de chat, pero una sola expansión.
  const bien = D.analizarStampede({ concurrentes: 5, tema: 'x', ms: 10, llamadasChat: 4, llamadasExpansion: 1, llamadasJuez: 3, llamadasEmbedding: 1, errores: 0 });
  assert.equal(bien[0].id, 'D-EXPANSION-OK');
  assert.match(bien[0].titulo, /hicieron 1 expansión$/);
  assert.match(bien[0].evidencia[0], /preguntas a jueces: 3/);
  const mal = D.analizarStampede({ concurrentes: 5, tema: 'x', ms: 10, llamadasChat: 8, llamadasExpansion: 5, llamadasJuez: 3, llamadasEmbedding: 5, errores: 0 });
  assert.equal(mal[0].id, 'D-STAMPEDE-EXPANSION');
  assert.match(mal[0].titulo, /hicieron 5 expansiones/);
  const sinDato = D.analizarStampede({ concurrentes: 5, tema: 'x', ms: 10, llamadasChat: 3, llamadasEmbedding: 1, errores: 0 });
  assert.equal(sinDato[0].id, 'D-STAMPEDE-EXPANSION', 'sin el desglose (datos viejos) vale el total de llamadas de chat');
});

test('D llamada gigante: informa las expansiones por separado de las preguntas a los jueces', () => {
  const r = D.analizarMega({ topics: 10, ms: 1000, error: null, timeout: false, resultados: 10, rescates: 0, erroresBusqueda: 0, llamadasChat: 40, llamadasExpansion: 10, llamadasJuez: 30, violaciones: [] });
  assert.match(hallazgo(r, 'D-MEGA-SECUENCIAL').evidencia[0], /expansiones en OpenAI: 10 · preguntas a jueces: 30/);
});

test('D llamada gigante: falla, búsquedas tragadas, violaciones y tiempo por tópico', () => {
  const ok = D.analizarMega({ topics: 100, ms: 5000, error: null, timeout: false, resultados: 100, rescates: 4, erroresBusqueda: 0, llamadasChat: 90, violaciones: [] });
  assert.deepEqual(ids(ok), ['D-MEGA-SECUENCIAL']);
  assert.match(hallazgo(ok, 'D-MEGA-SECUENCIAL').titulo, /100 tópicos .* 5000 ms \(≈50 ms por tópico\)/);

  const mal = D.analizarMega({ topics: 100, ms: 9, error: 'boom', timeout: false, resultados: 0, rescates: 0, erroresBusqueda: 3, llamadasChat: 0, violaciones: [viol('I1-EDAD')] });
  assert.equal(hallazgo(mal, 'D-MEGA-FALLA').severidad, 'ALTA');
  assert.equal(hallazgo(mal, 'D-MEGA-ERRORES-TRAGADOS').severidad, 'MEDIA');
  assert.ok(!ids(mal).includes('D-MEGA-SECUENCIAL'), 'si falló no se informa el tiempo');
  const violacion = hallazgo(mal, 'D-MEGA-I1-EDAD');
  assert.ok(violacion);
  assert.equal(violacion.escenario, 'D', 'se agrupa con el resto del escenario D');
  assert.deepEqual(D.analizarMega(null), []);
});

test('D analizarCarga: junta rampas, candado, ráfaga y llamada gigante', () => {
  const r = D.analizarCarga({
    rampaPick: [paso(1), paso(2)], rampaDigest: null, lock: lockOk(),
    stampede: { concurrentes: 5, tema: 'x', ms: 1, llamadasChat: 1, llamadasEmbedding: 1, errores: 0 },
    mega: { topics: 10, ms: 100, error: null, resultados: 10, rescates: 0, erroresBusqueda: 0, llamadasChat: 10, violaciones: [] },
  });
  for (const id of ['D-SIN-QUIEBRE-PICK', 'D-LOCK-OK', 'D-EXPANSION-OK', 'D-MEGA-SECUENCIAL']) assert.ok(ids(r).includes(id), id);
  assert.equal(r.resumen.rampaDigest, null);
  assert.equal(r.resumen.rampaPick.quiebre, null);
  assert.equal(r.resumen.rampaPick.filas.length, 2);
  assert.deepEqual(D.analizarCarga().hallazgos, []);
});

// ================================================================= globales
test('G: escrituras en Mongo (crítico), embeddings repetidos y corrida parcial', () => {
  const base = { openai: { embeddings: { llamadas: 0, unicos: 0 } }, mongo: { escrituras: 0 } };
  assert.deepEqual(D.hallazgosGlobales({ contadores: base }), []);
  assert.deepEqual(D.hallazgosGlobales(), []);

  const escribio = D.hallazgosGlobales({ contadores: { ...base, mongo: { escrituras: 2 } } });
  assert.equal(hallazgo(escribio, 'G-ESCRITURAS').severidad, 'CRITICA');
  assert.match(hallazgo(escribio, 'G-ESCRITURAS').titulo, /2 comando/);
  assert.doesNotMatch(hallazgo(escribio, 'G-ESCRITURAS').detalle, /Comandos vistos/, 'sin ejemplos no inventa nada');
  const conEjemplos = D.hallazgosGlobales({ contadores: { ...base, mongo: { escrituras: 2, ejemplosEscritura: 'insert en prod; aggregate en prod' } } });
  assert.match(hallazgo(conEjemplos, 'G-ESCRITURAS').detalle, /Comandos vistos: insert en prod; aggregate en prod\./, 'dice QUÉ comandos escribieron');

  const repetidos = D.hallazgosGlobales({ contadores: { ...base, openai: { embeddings: { llamadas: 40, unicos: 10 } } } });
  assert.equal(hallazgo(repetidos, 'G-EMBEDDINGS-REPETIDOS').severidad, 'BAJA');
  assert.deepEqual(D.hallazgosGlobales({ contadores: { ...base, openai: { embeddings: { llamadas: 10, unicos: 2 } } } }), [], 'pocas llamadas: sin conclusión');
  assert.deepEqual(D.hallazgosGlobales({ contadores: { ...base, openai: { embeddings: { llamadas: 40, unicos: 35 } } } }), [], 'casi todos distintos: normal');

  const parcial = D.hallazgosGlobales({ parcial: true, motivoParada: 'interrumpida con Ctrl+C' });
  assert.equal(hallazgo(parcial, 'G-PARCIAL').severidad, 'INFO');
  assert.match(hallazgo(parcial, 'G-PARCIAL').titulo, /Ctrl\+C/);
});

// ================================================================= auditoría estática
const FUENTES_CON_PROBLEMAS = {
  busqueda: 'const projectFields = { title: 1, url: 1 };',
  historial: 'UserShownArticle.find().limit(30).lean(); return { urls, seenEmbeddings };',
  digest: 'const t = [...new Set(history.titles)];',
  openai: 'const cliente = new OpenAI({ apiKey });',
  server: 'await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });',
  pick: 'const queryExpansionCache = new Map();\nconst TOPIC_TO_CATEGORY = Object.fromEntries(pares);\nconst c = TOPIC_TO_CATEGORY[topic];\nconst q = `${cat} Argentina actualidad nacional`;',
  cron: 'for (const user of usersInWindow) { await buildDigestForUser(user._id); }',
  ingesta: 'const TOPIC_TO_CATEGORY = Object.fromEntries(pares);\nif (TOPIC_TO_CATEGORY[topic]) category = TOPIC_TO_CATEGORY[topic];',
  rutas: "router.get('/digest', async () => { const run = await UserDeliveryRun.findOne({ userId }); return res.json(run.digest); });",
};
const FUENTES_ARREGLADAS = {
  busqueda: 'const projectFields = { title: 1, url: 1, embedding: 1 };',
  historial: 'find().limit(200); return { urls, titles, seenEmbeddings };',
  digest: 'const t = [...new Set(history.titles)];',
  openai: 'new OpenAI({ apiKey, timeout: 20000, maxRetries: 1 })',
  server: 'await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, maxPoolSize: 20, socketTimeoutMS: 30000 });',
  pick: 'const queryExpansionCache = new Map(); queryExpansionCache.delete(k);\nconst c = Object.hasOwn(TOPIC_TO_CATEGORY, topic) ? TOPIC_TO_CATEGORY[topic] : null;\nconst TOPIC_TO_CATEGORY = Object.fromEntries(pares);',
  cron: 'await Promise.all(usersInWindow.map((u) => buildDigestForUser(u._id)));',
  ingesta: 'const TOPIC_TO_CATEGORY = Object.fromEntries(pares);\nif (Object.hasOwn(TOPIC_TO_CATEGORY, topic)) category = TOPIC_TO_CATEGORY[topic];',
  rutas: "router.get('/digest', async () => { const run = await UserDeliveryRun.findOne({ userId }); const { digest } = await ensureFreshDigest(run, deps); return res.json(digest); });",
};

test('estático: detecta los 10 problemas de diseño en un código que los tiene', () => {
  const r = auditarFuentes(FUENTES_CON_PROBLEMAS);
  assert.deepEqual(r.map((h) => h.id).sort(), [
    'S-CACHE-EXPANSION-SIN-LIMITE', 'S-CRON-SECUENCIAL', 'S-DIGEST-GUARDADO-SIN-REVISAR-EDAD', 'S-LOOKUP-EN-OBJETO-COMUN',
    'S-MONGO-SIN-POOL-NI-SOCKET-TIMEOUT', 'S-OPENAI-SIN-TIMEOUT', 'S-RESCATE-CONSULTA-FIJA', 'S-SIN-EMBEDDING-EN-CANDIDATOS',
    'S-TITULOS-DEL-HISTORIAL-NUNCA-LLEGAN', 'S-VENTANA-HISTORIAL-30',
  ]);
  assert.ok(r.every((h) => h.escenario === 'S'));
  assert.equal(r.find((h) => h.id === 'S-SIN-EMBEDDING-EN-CANDIDATOS').severidad, 'ALTA');
  assert.equal(r.find((h) => h.id === 'S-DIGEST-GUARDADO-SIN-REVISAR-EDAD').severidad, 'ALTA');
});

test('estático: el digest guardado se marca solo si las rutas no revisan la edad de sus notas', () => {
  const idsDe = (f) => auditarFuentes(f).map((h) => h.id);
  assert.ok(idsDe({ rutas: FUENTES_CON_PROBLEMAS.rutas }).includes('S-DIGEST-GUARDADO-SIN-REVISAR-EDAD'));
  assert.ok(!idsDe({ rutas: FUENTES_ARREGLADAS.rutas }).includes('S-DIGEST-GUARDADO-SIN-REVISAR-EDAD'));
  assert.deepEqual(idsDe({ rutas: 'router.get("/ping", () => "ok");' }), [], 'unas rutas sin digests guardados no tienen nada que revisar');
});

test('estático: el lookup en objeto común se marca en el motor y en la ingesta, cada uno por separado', () => {
  const lookup = (f) => hallazgo(auditarFuentes(f), 'S-LOOKUP-EN-OBJETO-COMUN');
  const soloIngesta = lookup({ ingesta: FUENTES_CON_PROBLEMAS.ingesta, pick: FUENTES_ARREGLADAS.pick });
  assert.deepEqual(soloIngesta.evidencia, ['ingestion/reviewArticlesWithAIBatch.js']);
  const soloMotor = lookup({ pick: FUENTES_CON_PROBLEMAS.pick, ingesta: FUENTES_ARREGLADAS.ingesta });
  assert.deepEqual(soloMotor.evidencia, ['utils/pickBestArticlePerTopic.js']);
  assert.equal(lookup({ pick: FUENTES_ARREGLADAS.pick, ingesta: FUENTES_ARREGLADAS.ingesta }), undefined);
});

test('estático: el filtro de "misma historia" no se marca como roto si el motor lee los embeddings de los finalistas', () => {
  const sinProyectar = { busqueda: 'const projectFields = { title: 1, url: 1 };' };
  assert.ok(ids(auditarFuentes(sinProyectar)).includes('S-SIN-EMBEDDING-EN-CANDIDATOS'));
  for (const lector of ['const vectors = await store.loadEmbeddings(ids);', 'function embeddingLoader(store) {}']) {
    assert.ok(!ids(auditarFuentes({ ...sinProyectar, pick: lector })).includes('S-SIN-EMBEDDING-EN-CANDIDATOS'), lector);
  }
});

test('estático: con timeout y reintentos acotados en el camino del digest, el cliente de OpenAI sin opciones ya no se marca', () => {
  const cliente = { openai: 'const cliente = new OpenAI({ apiKey });' };
  assert.ok(ids(auditarFuentes(cliente)).includes('S-OPENAI-SIN-TIMEOUT'));
  const soloUno = { ...cliente, busqueda: 'create(body, { timeout: 8000, maxRetries: 1 })', pick: 'sin opciones' };
  assert.ok(ids(auditarFuentes(soloUno)).includes('S-OPENAI-SIN-TIMEOUT'), 'si una de las dos llamadas queda sin acotar, sigue marcado');
  const ambos = { ...cliente, busqueda: 'create(body, { timeout: 8000, maxRetries: 1 })', pick: 'create(body, { timeout: 8000, maxRetries: 1 })' };
  assert.ok(!ids(auditarFuentes(ambos)).includes('S-OPENAI-SIN-TIMEOUT'));
});

test('estático: cuando el código ya está arreglado, los hallazgos desaparecen (sin falsos positivos)', () => {
  assert.deepEqual(auditarFuentes(FUENTES_ARREGLADAS).map((h) => h.id), []);
});

test('estático: sin archivos (vacíos o ausentes) no inventa hallazgos', () => {
  assert.deepEqual(auditarFuentes({}), []);
  assert.deepEqual(auditarFuentes({ busqueda: '', historial: '', digest: '', openai: '', server: '', pick: '', cron: '', ingesta: '', rutas: '' }), []);
});

test('estático: leerFuentes encuentra todos los archivos auditados (si se renombra uno, la auditoría quedaría ciega)', () => {
  const src = path.resolve(__dirname, '..', '..');
  const f = leerFuentes(src);
  for (const clave of Object.keys(ARCHIVOS)) assert.ok(f[clave] && f[clave].length > 50, `no se pudo leer ${ARCHIVOS[clave]}: actualizar estres/estatico.js`);
  assert.deepEqual(leerFuentes(path.join(src, 'no-existe')), Object.fromEntries(Object.keys(ARCHIVOS).map((k) => [k, ''])));
});
