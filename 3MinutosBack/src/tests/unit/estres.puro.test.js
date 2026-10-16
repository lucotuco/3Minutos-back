'use strict';

/**
 * Tests del núcleo PURO del test de estrés: estadística, configuración, argumentos,
 * hallazgos e invariantes. Todo con datos inventados: no toca Mongo ni OpenAI.
 *   npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../estres/estadisticas');
const C = require('../estres/config');
const { parseArgs, lista } = require('../estres/args');
const { elegirEscenarios } = require('../estres/cli');
const H = require('../estres/hallazgo');
const I = require('../estres/invariantes');

// ================================================================= estadística
test('percentil: rango más cercano, ignora valores no finitos y no ordena el original', () => {
  assert.equal(E.percentil([], 50), null);
  assert.equal(E.percentil([5], 99), 5);
  assert.equal(E.percentil([1, 2, 3, 4, 5], 50), 3);
  assert.equal(E.percentil([1, 2, 3, 4, 5], 100), 5);
  assert.equal(E.percentil([10, NaN, 'x', null, Infinity, 20], 100), 20);
  const original = [3, 1, 2];
  E.percentil(original, 50);
  assert.deepEqual(original, [3, 1, 2]);
});

test('resumenLatencias: vacío y caso simple', () => {
  assert.deepEqual(E.resumenLatencias([]), { n: 0, min: null, p50: null, p95: null, p99: null, max: null, media: null });
  assert.deepEqual(E.resumenLatencias([10, 20, 30, 40]), { n: 4, min: 10, p50: 20, p95: 40, p99: 40, max: 40, media: 25 });
});

test('moda, transiciones, conteo y agrupar', () => {
  assert.deepEqual(E.moda(['a', 'b', 'a', null, undefined]), { valor: 'a', cuenta: 2, total: 3 });
  assert.deepEqual(E.moda([]), { valor: null, cuenta: 0, total: 0 });
  assert.equal(E.moda(['x', 'y']).valor, 'x', 'en empate gana el primero');

  assert.equal(E.transiciones([]), 0);
  assert.equal(E.transiciones(['a', 'a', 'b', 'b', 'a']), 2);
  assert.equal(E.transiciones([null, undefined, null]), 0, 'null y undefined cuentan como "nada"');
  assert.equal(E.transiciones(['a', null, 'a']), 2);

  assert.deepEqual(E.conteo([null, 'a', 'a', 3]), { '(ninguno)': 1, a: 2, 3: 1 });
  const g = E.agrupar([1, 2, 3, 4, 5], (x) => x % 2);
  assert.deepEqual(g.get(1), [1, 3, 5]);
  assert.deepEqual(g.get(0), [2, 4]);
});

test('pendiente: recta de mínimos cuadrados y casos degenerados', () => {
  assert.equal(E.pendiente([0, 1, 2, 3], [1, 3, 5, 7]), 2);
  assert.equal(E.pendiente([0, 1, 2], [5, 5, 5]), 0);
  assert.equal(E.pendiente([1], [1]), 0);
  assert.equal(E.pendiente([], []), 0);
  assert.equal(E.pendiente([2, 2, 2], [1, 2, 3]), 0, 'x constante: sin pendiente');
});

test('mulberry32 / barajar / muestrear / permutaciones: determinísticos y sin mutar', () => {
  const a = Array.from({ length: 6 }, E.mulberry32(42));
  const b = Array.from({ length: 6 }, E.mulberry32(42));
  assert.deepEqual(a, b);
  assert.ok(a.every((x) => x >= 0 && x < 1));
  assert.notDeepEqual(a, Array.from({ length: 6 }, E.mulberry32(43)));

  const base = [1, 2, 3, 4, 5, 6, 7, 8];
  const mezclado = E.barajar(base, E.mulberry32(1));
  assert.deepEqual([...mezclado].sort(), base, 'mismos elementos');
  assert.deepEqual(base, [1, 2, 3, 4, 5, 6, 7, 8], 'no muta el original');
  assert.deepEqual(E.barajar(base, E.mulberry32(1)), mezclado, 'misma semilla, mismo orden');

  assert.equal(E.muestrear(base, 3, E.mulberry32(5)).length, 3);
  assert.deepEqual(E.muestrear(base, 0), []);
  assert.deepEqual(E.muestrear(base, -2), []);
  assert.equal(E.muestrear(base, 99).length, 8);

  const p = E.permutaciones(['a', 'b', 'c']);
  assert.equal(p.length, 6);
  assert.equal(new Set(p.map((x) => x.join(''))).size, 6);
  assert.deepEqual(E.permutaciones(['a']), [['a']]);
});

test('coseno y similitud de títulos', () => {
  assert.equal(E.coseno([1, 0], [1, 0]), 1);
  assert.equal(E.coseno([1, 0], [0, 1]), 0);
  assert.equal(E.coseno([], []), 0);
  assert.equal(E.coseno([1, 2], [1, 2, 3]), 0, 'largos distintos');
  assert.equal(E.coseno([0, 0], [1, 1]), 0, 'vector nulo');
  assert.equal(E.coseno(null, [1]), 0);

  const toks = E.tokensTitulo('El Dólar blue cerró en $1.200 con los bancos');
  for (const t of ['dolar', 'blue', 'cerro', 'bancos']) assert.ok(toks.has(t), t);
  for (const t of ['los', 'con', 'el', 'en']) assert.ok(!toks.has(t), `no debería tener "${t}"`);

  assert.equal(E.similitudTitulos('Boca ganó el clásico', 'Boca ganó el clásico'), 1);
  assert.ok(E.similitudTitulos('Boca ganó el clásico en La Bombonera', 'Boca ganó el clásico en la Bombonera hoy') >= 0.6);
  assert.equal(E.similitudTitulos('Milei habló del dólar', 'Colapinto largará octavo'), 0);
  assert.equal(E.similitudTitulos('', 'algo'), 0);
  assert.equal(E.mb(1048576), 1);
  assert.equal(E.mb(1572864), 1.5);
});

// ================================================================= config
test('resolverNivel: copia profunda y overrides del CLI', () => {
  const n = C.resolverNivel('suave', {});
  n.A.repeticiones = 999;
  assert.equal(C.NIVELES.suave.A.repeticiones, 3, 'no debe tocar la plantilla');

  const o = C.resolverNivel('medio', {
    repeticiones: '7', rondas: '2', libres: '5', concurrencia: '3', timeout: '10',
    'max-openai': '99', 'max-minutos': '3', 'soak-minutos': '0.5', rampa: '1,3,5',
  });
  assert.equal(o.A.repeticiones, 7);
  assert.equal(o.B.rondas, 2);
  assert.equal(o.B.rondasSesion, 2);
  assert.equal(o.libres, 5);
  assert.equal(o.concurrencia, 3);
  assert.equal(o.timeoutS, 10);
  assert.equal(o.maxOpenAI, 99);
  assert.equal(o.maxMinutos, 3);
  assert.equal(o.F.minutos, 0.5);
  assert.deepEqual(o.D.rampa, [1, 3, 5]);

  assert.throws(() => C.resolverNivel('inexistente', {}), /Nivel desconocido/);
});

test('resolverNivel: valores inválidos se ignoran y --concurrencia-max recorta la rampa', () => {
  const n = C.resolverNivel('suave', { repeticiones: 'abc', libres: '-4', concurrencia: '0', rampa: 'x,y' });
  assert.equal(n.A.repeticiones, 3);
  assert.equal(n.libres, 10);
  assert.equal(n.concurrencia, 2);
  assert.deepEqual(n.D.rampa, [1, 2, 4]);

  assert.deepEqual(C.resolverNivel('maximo', { 'concurrencia-max': '8' }).D.rampa, [1, 2, 4, 8]);
  assert.deepEqual(C.resolverNivel('suave', { rampa: '4,8', 'concurrencia-max': '2' }).D.rampa, [1], 'si no queda nada, queda 1');
  assert.deepEqual(C.resolverNivel('suave', { 'concurrencia-max': 'abc' }).D.rampa, [1, 2, 4], 'valor inválido: no recorta');
  assert.equal(C.resolverNivel('maximo', { 'soak-minutos': '0' }).F.minutos, 0);
});

test('los tres niveles tienen la misma forma y escalan', () => {
  for (const nombre of ['suave', 'medio', 'maximo']) {
    const n = C.NIVELES[nombre];
    for (const clave of ['oficiales', 'libres', 'concurrencia', 'A', 'B', 'C', 'D', 'E', 'F', 'timeoutS', 'maxOpenAI', 'maxMinutos']) {
      assert.ok(n[clave] !== undefined, `${nombre}.${clave}`);
    }
    assert.equal(n.nombre, nombre);
    assert.ok(n.D.rampa.every((c, i, r) => i === 0 || c > r[i - 1]), `${nombre}: rampa creciente`);
  }
  const { suave, medio, maximo } = C.NIVELES;
  assert.ok(suave.libres < medio.libres && medio.libres < maximo.libres);
  assert.ok(suave.maxOpenAI < medio.maxOpenAI && medio.maxOpenAI < maximo.maxOpenAI);
  assert.ok(Math.max(...maximo.D.rampa) > Math.max(...medio.D.rampa));
  assert.equal(suave.F.minutos, 0, 'el soak solo corre en el nivel máximo (o con --soak-minutos)');
  assert.ok(maximo.F.minutos > 0);
});

test('hostiles: ids únicos, básicos ⊂ todos y cubren los casos peligrosos', () => {
  const ids = C.HOSTILES.map((h) => h.id);
  assert.equal(new Set(ids).size, ids.length);
  const basicos = C.hostilesDe('basicos');
  const todos = C.hostilesDe('todos');
  assert.ok(basicos.length > 0 && basicos.length < todos.length);
  assert.ok(basicos.every((h) => todos.includes(h)));
  for (const necesario of ['vacio', 'null', 'constructor', 'proto', 'mongo_operador', 'regex', 'emoji', 'largo_5000', 'palabra_inventada']) {
    assert.ok(ids.includes(necesario), `falta el hostil "${necesario}"`);
  }
  for (const g of ['vacios', 'no_string', 'extremos', 'unicode', 'inyeccion', 'prototipo', 'ruido']) {
    assert.ok(C.HOSTILES.some((h) => h.grupo === g), `falta el grupo ${g}`);
  }
  assert.equal(C.HOSTILES.find((h) => h.id === 'largo_5000').valor.length, 5000);
});

test('describirValor muestra cualquier cosa sin romperse', () => {
  assert.equal(C.describirValor(undefined), 'undefined');
  assert.equal(C.describirValor(null), 'null');
  assert.equal(C.describirValor('hola'), '"hola"');
  assert.match(C.describirValor('x'.repeat(5000)), /\(5000 car\.\)$/);
  assert.equal(C.describirValor({ a: 1 }), '{"a":1}');
  const circular = {};
  circular.yo = circular;
  assert.equal(typeof C.describirValor(circular), 'string');
});

test('variantesDe: mayúsculas, capitalizado y sin acentos, sin repetir', () => {
  const v = C.variantesDe('dólar blue');
  assert.deepEqual(v.map((x) => x.id), ['original', 'MAYUSCULAS', 'Capitalizado', 'sin_acentos']);
  assert.equal(v.find((x) => x.id === 'MAYUSCULAS').valor, 'DÓLAR BLUE');
  assert.equal(v.find((x) => x.id === 'Capitalizado').valor, 'Dólar Blue');
  assert.equal(v.find((x) => x.id === 'sin_acentos').valor, 'dolar blue');

  const r = C.variantesDe('  River Plate ');
  assert.equal(r[0].valor, 'River Plate', 'recorta espacios');
  assert.deepEqual(r.map((x) => x.id), ['original', 'minusculas', 'MAYUSCULAS']);
  assert.equal(new Set(r.map((x) => x.valor)).size, r.length);
  assert.deepEqual(C.variantesDe(null), [{ id: 'original', valor: '' }]);
});

test('tareasEscalon y tamanios: las cantidades que ve --dry-run son las que usan los escenarios', () => {
  const n = JSON.parse(JSON.stringify(C.NIVELES.suave));
  Object.assign(n, {
    libres: 6, A: { repeticiones: 3 },
    B: { temas: 4, rondas: 3, sesiones: 2, rondasSesion: 3 },
    C: { triplas: 4, repeticiones: 2, permutar: true },
    D: { rampa: [1, 2, 4], tareasMin: 4, tareasPorWorker: 1, mega: 8, lock: 4, stampede: 5 },
    E: { hostiles: 'todos', variantes: 2, repeticiones: 1 },
  });
  assert.equal(C.tareasEscalon(n, 1), 4);
  assert.equal(C.tareasEscalon(n, 16), 16);

  const t = C.tamanios(n, { oficiales: 7, libres: 6, usuarios: 1, hostiles: 10 });
  assert.deepEqual(t.A, { picks: 39, busquedas: 39 });
  assert.deepEqual(t.B, { picks: 18, busquedas: 30 });
  assert.deepEqual(t.C, { picks: 48, busquedas: 144 });
  assert.deepEqual(t.D, { picks: 31, digests: 25, busquedas: 113 });
  assert.deepEqual(t.E, { picks: 20, busquedas: 20 });

  const sinUsuarios = C.tamanios(n, { oficiales: 7, libres: 6, usuarios: 0, hostiles: 10 });
  assert.equal(sinUsuarios.D.digests, 0);
  assert.equal(sinUsuarios.D.busquedas, 31 - 1 + 8 - 0 + 0, 'sin usuarios no hay digests ni sus búsquedas');
});

// ================================================================= args y selección de escenarios
test('parseArgs: banderas conocidas no se comen el argumento siguiente', () => {
  const a = parseArgs(['--nivel', 'medio', '--dry-run', '--solo', 'A,B', '--rampa=1,2', '--si', '--max-openai', '500']);
  assert.equal(a.nivel, 'medio');
  assert.equal(a['dry-run'], true);
  assert.equal(a.solo, 'A,B');
  assert.equal(a.rampa, '1,2');
  assert.equal(a.si, true);
  assert.equal(a['max-openai'], '500');
  const b = parseArgs(['--seguir-tras-quiebre', '--sin-usuarios', '--nivel', 'suave']);
  assert.equal(b['seguir-tras-quiebre'], true);
  assert.equal(b['sin-usuarios'], true);
  assert.equal(b.nivel, 'suave');
  assert.equal(parseArgs(['--semilla']).semilla, true, 'valor faltante: queda como bandera');
});

test('lista: separa por comas, recorta y descarta vacíos', () => {
  assert.deepEqual(lista('a, b ,,c'), ['a', 'b', 'c']);
  assert.deepEqual(lista(undefined), []);
  assert.deepEqual(lista(true), []);
  assert.deepEqual(lista(''), []);
});

test('elegirEscenarios: todos, --solo, --saltar y error en ids desconocidos', () => {
  assert.deepEqual(elegirEscenarios({}), ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.deepEqual(elegirEscenarios({ solo: 'a, c' }), ['A', 'C']);
  assert.deepEqual(elegirEscenarios({ saltar: 'D,F' }), ['A', 'B', 'C', 'E']);
  assert.deepEqual(elegirEscenarios({ solo: 'A,B,C', saltar: 'B' }), ['A', 'C']);
  assert.deepEqual(elegirEscenarios({ solo: true }), ['A', 'B', 'C', 'D', 'E', 'F'], '--solo sin valor no filtra');
  assert.throws(() => elegirEscenarios({ solo: 'A,Z' }), /Escenario desconocido: Z/);
  assert.throws(() => elegirEscenarios({ saltar: 'X' }), /Escenario desconocido: X/);
});

// ================================================================= hallazgos
test('hallazgo: recorta la evidencia; ordenar y peorSeveridad respetan la escala', () => {
  const h = H.hallazgo({ id: 'X', severidad: 'ALTA', escenario: 'A', titulo: 't', evidencia: Array.from({ length: 30 }, (_, i) => `e${i}`) });
  assert.equal(h.evidencia.length, 12);
  assert.equal(H.hallazgo({ id: 'Y', severidad: 'BAJA', escenario: 'A', titulo: 't' }).detalle, '');

  const orden = H.ordenar([
    { id: 'b', severidad: 'INFO' }, { id: 'z', severidad: 'ALTA' }, { id: 'a', severidad: 'ALTA' },
    { id: 'c', severidad: 'CRITICA' }, { id: 'd', severidad: 'MEDIA' }, { id: 'q', severidad: 'RARA' },
  ]).map((x) => x.id);
  assert.deepEqual(orden, ['c', 'a', 'z', 'd', 'b', 'q']);

  assert.equal(H.peorSeveridad(['BAJA', 'ALTA', 'INFO']), 'ALTA');
  assert.equal(H.peorSeveridad(['MEDIA', 'CRITICA']), 'CRITICA');
  assert.equal(H.peorSeveridad([]), 'INFO');
});

test('hallazgosDeViolaciones: un hallazgo por tipo, con conteo, peor severidad y ejemplos acotados', () => {
  const v = (id, severidad, topic) => ({ id, severidad, topic, mensaje: 'm' });
  const filas = [
    { violaciones: [v('I1-EDAD', 'MEDIA', 'a'), v('I8-DUPLICADO-LLAMADA', 'CRITICA', 'b')] },
    { violaciones: [v('I1-EDAD', 'ALTA', 'c')] },
    {},
    ...Array.from({ length: 20 }, (_, i) => ({ violaciones: [v('I10-SCORE', 'MEDIA', `t${i}`)] })),
  ];
  const hs = H.hallazgosDeViolaciones('B', filas);
  assert.deepEqual(hs.map((h) => h.id).sort(), ['B-I1-EDAD', 'B-I10-SCORE', 'B-I8-DUPLICADO-LLAMADA']);
  const edad = hs.find((h) => h.id === 'B-I1-EDAD');
  assert.equal(edad.severidad, 'ALTA');
  assert.match(edad.titulo, /2 vez/);
  assert.equal(edad.escenario, 'B');
  assert.equal(hs.find((h) => h.id === 'B-I10-SCORE').evidencia.length, 8);
  assert.deepEqual(H.hallazgosDeViolaciones('A', []), []);
});

// ================================================================= invariantes
const AHORA = Date.parse('2026-10-14T12:00:00Z');
const HORA = 3600e3;

const nota = (o = {}) => ({
  _id: 'a1', url: 'https://x.test/a1', title: 'River Plate ganó en el Monumental', rawSummary: 'Resumen sobre river plate',
  tags: ['river plate'], category: 'Deportes', topic: 'Fútbol', sourceName: 'Ole',
  publishedAt: new Date(AHORA - 5 * HORA), score: 0.97, finalScore: 80, ...o,
});
const resultado = (o = {}, a = nota()) => ({
  topic: 'river plate', queryExpanded: 'river plate', article: a, usedFallback: false, fallbackCategory: null,
  matchZone: 'VERDE', matchScore: 0.97, matchReason: 'VERDE score=0.970 (candidato #1)', corralCategory: 'Deportes', candidatesEvaluated: 3, ...o,
});
const ids = (vs) => vs.map((v) => v.id);
const verificar = (r, esperado = { tipo: 'libre' }, extra = {}) =>
  I.verificarResultado({ topic: 'river plate', r, esperado, ahora: AHORA, ...extra });

test('invariantes: un resultado sano no tiene violaciones', () => {
  assert.deepEqual(verificar(resultado()), []);
  assert.deepEqual(verificar(resultado(), { tipo: 'oficial', categoria: 'Deportes' }), []);
  const vacio = resultado({ article: null, matchZone: null, matchScore: null, matchReason: 'sin_candidatos', candidatesEvaluated: 0 });
  assert.deepEqual(verificar(vacio), [], 'sin nota y sin zona es un resultado válido');
});

test('I1: edad máxima (48 h, con un minuto de tolerancia), fecha faltante y fecha futura', () => {
  const viejo = verificar(resultado({}, nota({ publishedAt: new Date(AHORA - 60 * HORA) })));
  assert.ok(ids(viejo).includes('I1-EDAD'));
  assert.equal(viejo.find((v) => v.id === 'I1-EDAD').severidad, 'ALTA');
  assert.deepEqual(ids(verificar(resultado({}, nota({ publishedAt: new Date(AHORA - 48 * HORA) })))), [], '48 h justas: ok');
  assert.ok(ids(verificar(resultado({}, nota({ publishedAt: new Date(AHORA - 48.5 * HORA) })))).includes('I1-EDAD'));

  const sinFecha = verificar(resultado({}, nota({ publishedAt: undefined })));
  assert.equal(sinFecha.find((v) => v.id === 'I1-EDAD').severidad, 'MEDIA');
  assert.ok(ids(verificar(resultado({}, nota({ publishedAt: 'no es una fecha' })))).includes('I1-EDAD'));

  const futuro = verificar(resultado({}, nota({ publishedAt: new Date(AHORA + 5 * HORA) })));
  assert.equal(futuro.find((v) => v.id === 'I1-FECHA-FUTURA').severidad, 'BAJA');
  assert.deepEqual(ids(verificar(resultado({}, nota({ publishedAt: new Date(AHORA + 1 * HORA) })))), [], 'una hora de adelanto es tolerable');
});

test('I2: coherencia entre zona, score y rescate', () => {
  assert.ok(ids(verificar(resultado({ matchZone: 'VERDE', matchScore: 0.9 }))).includes('I2-ZONA'));
  assert.deepEqual(ids(verificar(resultado({ matchZone: 'AMARILLA', matchScore: 0.85 }, nota({ rawSummary: 'river plate', tags: [] })))), []);
  assert.ok(ids(verificar(resultado({ matchZone: 'AMARILLA', matchScore: 0.95 }))).includes('I2-ZONA'), 'AMARILLA no llega a 0.94');
  assert.ok(ids(verificar(resultado({ matchZone: 'AMARILLA', matchScore: 0.79 }))).includes('I2-ZONA'));
  assert.ok(ids(verificar(resultado({ matchZone: 'ROJA' }))).includes('I2-ZONA'), 'una nota de zona ROJA nunca se entrega');
  assert.ok(ids(verificar(resultado({ matchScore: null }))).includes('I2-ZONA'));
  assert.ok(ids(verificar(resultado({ usedFallback: true, matchZone: 'VERDE', matchReason: 'sin_candidatos' }))).includes('I2-ZONA'));
  assert.ok(ids(verificar(resultado({ article: null, matchZone: 'VERDE' }))).includes('I2-ZONA'));
  assert.ok(ids(verificar(resultado({ article: null, matchZone: null, usedFallback: true }))).includes('I2-ZONA'));
});

test('I13: un rescate tiene que decir por qué', () => {
  const bueno = resultado({ usedFallback: true, matchZone: 'RESCATE', matchReason: 'ningun_candidato_valido', matchScore: null, fallbackCategory: 'Deportes' });
  assert.deepEqual(verificar(bueno), []);
  for (const motivo of ['sin_candidatos', 'error_busqueda']) assert.deepEqual(verificar({ ...bueno, matchReason: motivo }), []);
  const malo = verificar({ ...bueno, matchReason: 'porque sí' });
  assert.deepEqual(ids(malo), ['I13-RESCATE-SIN-MOTIVO']);
});

test('I3 e I4: la categoría de un oficial es obligatoria; la inferida solo se marca', () => {
  const economia = resultado({}, nota({ category: 'Economía' }));
  const v = verificar(economia, { tipo: 'oficial', categoria: 'Deportes' });
  assert.ok(ids(v).includes('I3-CORRAL-OFICIAL'));
  assert.equal(v.find((x) => x.id === 'I3-CORRAL-OFICIAL').severidad, 'ALTA');

  const rescateOtraCat = resultado({ usedFallback: true, matchZone: 'RESCATE', matchReason: 'sin_candidatos', fallbackCategory: 'Política', matchScore: null }, nota({ category: 'Deportes' }));
  assert.ok(ids(verificar(rescateOtraCat, { tipo: 'oficial', categoria: 'Deportes' })).includes('I3-CORRAL-OFICIAL'));

  const libreFuera = resultado({ corralCategory: 'Deportes' }, nota({ category: 'Política' }));
  const w = verificar(libreFuera, { tipo: 'libre' });
  assert.ok(ids(w).includes('I4-CORRAL-INFERIDO'));
  assert.equal(w.find((x) => x.id === 'I4-CORRAL-INFERIDO').severidad, 'MEDIA');
  assert.ok(!ids(verificar(resultado({ corralCategory: null }, nota({ category: 'Política' })), { tipo: 'libre' })).includes('I4-CORRAL-INFERIDO'));
});

test('I5, I6, I6b e I10: trazabilidad, forma de la nota, opinión y scores', () => {
  assert.ok(ids(verificar(resultado({ matchReason: '' }))).includes('I5-TRAZA'));
  assert.ok(ids(verificar(resultado({ candidatesEvaluated: -1 }))).includes('I5-TRAZA'));
  assert.ok(ids(verificar(resultado({ queryExpanded: undefined }))).includes('I5-TRAZA'));
  const sinCorral = resultado();
  delete sinCorral.corralCategory;
  assert.ok(ids(verificar(sinCorral)).includes('I5-TRAZA'));

  assert.ok(ids(verificar(resultado({}, nota({ url: 'ftp://x' })))).includes('I6-FORMA'));
  assert.ok(ids(verificar(resultado({}, nota({ title: '   ' })))).includes('I6-FORMA'));
  assert.ok(ids(verificar(resultado({}, nota({ _id: undefined })))).includes('I6-FORMA'));

  assert.ok(ids(verificar(resultado({}, nota({ url: 'https://x.test/opinion/columna-1' })))).includes('I6b-OPINION'));
  assert.ok(ids(verificar(resultado({}, nota({ title: 'Columna de Fulano: river' })))).includes('I6b-OPINION'));
  assert.ok(ids(verificar(resultado({}, nota({ tags: ['editorial'] })))).includes('I6b-OPINION'));
  assert.equal(I.esOpinion(nota()), false);

  assert.ok(ids(verificar(resultado({}, nota({ score: 1.5 })))).includes('I10-SCORE'));
  assert.ok(ids(verificar(resultado({}, nota({ finalScore: 'alto' })))).includes('I10-SCORE'));
});

test('I7: repetir una nota del historial es CRÍTICO', () => {
  const historial = new Set(['https://x.test/a1']);
  const v = verificar(resultado(), { tipo: 'libre' }, { historial });
  assert.deepEqual(ids(v), ['I7-REPETIDO-HISTORIAL']);
  assert.equal(v[0].severidad, 'CRITICA');
  assert.deepEqual(verificar(resultado(), { tipo: 'libre' }, { historial: new Set(['otra']) }), []);
});

test('I11: AMARILLA sin ninguna palabra del tópico (y sinTexto la desactiva)', () => {
  const sinPalabra = resultado({ matchZone: 'AMARILLA', matchScore: 0.85 }, nota({ title: 'Milei viajó a Madrid', rawSummary: 'agenda del presidente', tags: [] }));
  assert.ok(ids(verificar(sinPalabra, { tipo: 'libre' })).includes('I11-AMARILLA-SIN-PALABRA'));
  assert.ok(!ids(verificar(sinPalabra, { tipo: 'libre', sinTexto: true })).includes('I11-AMARILLA-SIN-PALABRA'));
  assert.ok(!ids(verificar(sinPalabra, { tipo: 'oficial', categoria: 'Deportes' })).includes('I11-AMARILLA-SIN-PALABRA'));
  assert.equal(I.mencionaAlguna('el la los', nota()), null, 'sin palabras evaluables no se puede decidir');
  assert.equal(I.mencionaAlguna('river plate', nota()), true);
  assert.equal(I.mencionaAlguna('boca juniors', nota()), false);
});

test('I0: faltan resultados o no es un objeto', () => {
  assert.deepEqual(ids(I.verificarResultado({ topic: 'x', r: null, ahora: AHORA })), ['I0-FORMA-RESULTADO']);
  assert.deepEqual(ids(I.verificarResultado({ topic: 'x', r: 'hola', ahora: AHORA })), ['I0-FORMA-RESULTADO']);
  assert.deepEqual(ids(I.verificarResultado({ topic: 12345, r: undefined, ahora: AHORA })), ['I0-FORMA-RESULTADO'], 'topic no string tampoco rompe');
});

test('verificarLlamada: alineación (I9) y duplicados dentro de una llamada (I8)', () => {
  const topics = ['river plate', 'boca juniors'];
  const rB = resultado({ topic: 'boca juniors' }, nota({ _id: 'a2', url: 'https://x.test/a2', title: 'Boca ganó', rawSummary: 'boca juniors', tags: [] }));
  assert.deepEqual(I.verificarLlamada({ topics, resultados: [resultado(), rB], esperados: [{ tipo: 'libre' }, { tipo: 'libre' }], ahora: AHORA }), []);

  const dup = I.verificarLlamada({ topics, resultados: [resultado(), resultado({ topic: 'boca juniors' })], ahora: AHORA });
  const d = dup.find((v) => v.id === 'I8-DUPLICADO-LLAMADA');
  assert.ok(d, 'la misma nota para dos tópicos');
  assert.equal(d.severidad, 'CRITICA');
  assert.equal(d.url, 'https://x.test/a1');

  const corto = I.verificarLlamada({ topics, resultados: [resultado()], ahora: AHORA });
  assert.ok(ids(corto).includes('I9-ALINEACION'));
  const cruzado = I.verificarLlamada({ topics, resultados: [rB, resultado()], ahora: AHORA });
  assert.ok(ids(cruzado).includes('I9-ALINEACION'));

  const conVacios = I.verificarLlamada({ topics: ['river plate', '', '   ', null], resultados: [resultado()], ahora: AHORA });
  assert.deepEqual(conVacios, [], 'los tópicos vacíos no llegan a producción: no deben contar');

  const noArray = I.verificarLlamada({ topics, resultados: null, ahora: AHORA });
  assert.equal(noArray[0].id, 'I0-FORMA-RESULTADO');
  assert.equal(noArray[0].severidad, 'CRITICA');
});

test('verificarLlamada: el historial se aplica a cada resultado', () => {
  const v = I.verificarLlamada({ topics: ['river plate'], resultados: [resultado()], historial: new Set(['https://x.test/a1']), ahora: AHORA });
  assert.deepEqual(ids(v), ['I7-REPETIDO-HISTORIAL']);
});

test('clasificar, resumenArticulo y edadHoras', () => {
  assert.equal(I.clasificar(null), 'sin_resultado');
  assert.equal(I.clasificar('x'), 'sin_resultado');
  assert.equal(I.clasificar({ article: null }), 'vacio');
  assert.equal(I.clasificar({ article: nota(), usedFallback: true }), 'rescate');
  assert.equal(I.clasificar({ article: nota(), usedFallback: false }), 'tema');

  assert.equal(I.resumenArticulo(null), null);
  const r = I.resumenArticulo(nota(), AHORA);
  assert.deepEqual(r, {
    id: 'a1', url: 'https://x.test/a1', titulo: 'River Plate ganó en el Monumental', categoria: 'Deportes', subtema: 'Fútbol',
    fuente: 'Ole', edadHoras: 5, score: 0.97, finalScore: 80,
  });
  assert.equal(I.edadHoras({ publishedAt: 'basura' }, AHORA), null);
  assert.equal(I.edadHoras({}, AHORA), null);
  assert.equal(I.edadHoras({ publishedAt: new Date(AHORA - 2 * HORA) }, AHORA), 2);
});

test('paresCasiDuplicados: por embeddings si hay, por títulos si no', () => {
  const n = (id, titulo) => ({ id, titulo });
  const a = n('1', 'Boca ganó el clásico en La Bombonera');
  const b = n('2', 'Boca ganó el clásico en la Bombonera hoy');
  const c = n('3', 'Milei habló del dólar');
  const porTitulo = I.paresCasiDuplicados([a, b, c]);
  assert.equal(porTitulo.length, 1);
  assert.equal(porTitulo[0].medida, 'titulos');
  assert.deepEqual([porTitulo[0].a.id, porTitulo[0].b.id], ['1', '2']);

  const vectores = new Map([['1', [1, 0]], ['2', [0, 1]], ['3', [1, 0.01]]]);
  const porVector = I.paresCasiDuplicados([a, b, c], { vectores });
  assert.equal(porVector.length, 1, 'los vectores mandan: 1 y 3 son casi iguales aunque los títulos no se parezcan');
  assert.equal(porVector[0].medida, 'coseno');
  assert.deepEqual([porVector[0].a.id, porVector[0].b.id], ['1', '3']);

  assert.deepEqual(I.paresCasiDuplicados([a, { ...a }]), [], 'la misma nota (mismo id) no es un par');
  assert.deepEqual(I.paresCasiDuplicados([a]), []);
  assert.deepEqual(I.paresCasiDuplicados([]), []);
  assert.deepEqual(I.paresCasiDuplicados([a, null, b].filter(Boolean).slice(0, 1)), []);
});
