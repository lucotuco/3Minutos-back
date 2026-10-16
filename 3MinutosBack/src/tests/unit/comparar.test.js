'use strict';

/**
 * Tests de la lógica del comparador (métricas, veredicto, reporte, parser de argumentos).
 * Correr:  npm run test:unit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs } = require('../comparar/utilidades');
const {
  mencionaTema, relevanciaDe, particion, resumir, soloEnComun, compararVersiones, chequeosCordura, veredicto,
} = require('../comparar/metricas');
const { construirTemas, temasOficiales, verificarOficialesContraCodigo } = require('../comparar/temas');
const { htmlReporte, csvComparacion, textoConsola } = require('../comparar/reporte');

let n = 0;
function reg(tema, overrides = {}, articulo = {}) {
  const base = {
    tema, tipo: 'libre', nivel: 'libre', usuarios: null, ms: 100, error: null,
    entregada: true, rescate: false, zona: 'AMARILLA', scoreBusqueda: 0.85, motivo: 'AMARILLA', corral: 'Deportes',
    candidatosEvaluados: 1, juez: 'SI', logs: [],
  };
  const out = { ...base, ...overrides };
  if (out.entregada) {
    out.articulo = {
      id: String(n), titulo: `Nota ${n} de ${tema}`, url: `https://x.test/${n++}`, fuente: 'Ole', categoria: 'Deportes',
      subtema: 'Fútbol', edadHoras: 10, score: 0.85, menciona: true, mencionaEnTitulo: true,
      categoriaOk: out.tipo === 'oficial' ? true : null, subtemaOk: out.tipo === 'oficial' ? true : null, ...articulo,
    };
  } else {
    out.articulo = null;
  }
  return out;
}

const corrida = (resultados, meta = {}) => ({
  meta: { etiqueta: 'x', commit: 'abc1234', rama: 'main', baseDeDatos: 'test', dbArticulos48h: 1000,
    digestLog: { validaOk: true, guardaCamposNuevos: true }, ...meta },
  resultados,
});

// ---------------------------------------------------------------- argumentos

test('parseArgs: comando, valores, = y banderas que no se comen el argumento siguiente', () => {
  const a = parseArgs(['todo', '--rapido', '--top', '50', '--baseline=abc', '--sin-juez']);
  assert.deepEqual(a._, ['todo']);
  assert.equal(a.rapido, true);
  assert.equal(a.top, '50');
  assert.equal(a.baseline, 'abc');
  assert.equal(a['sin-juez'], true);
  const b = parseArgs(['comparar', 'antes', 'despues_f25', '--abrir']);
  assert.deepEqual(b._, ['comparar', 'antes', 'despues_f25']);
  assert.equal(b.abrir, true);
});

// ---------------------------------------------------------------- menciona / relevancia

test('mencionaTema: frase completa o al menos la mitad de las palabras', () => {
  assert.equal(mencionaTema('river plate', 'Ganó River por 2 a 0'), true); // 1 de 2 palabras
  assert.equal(mencionaTema('river plate', 'Boca y Racing empataron'), false);
  assert.equal(mencionaTema('milei', 'El presidente Javier Milei viajó'), true);
  assert.equal(mencionaTema('milei', 'Rivera Milena'), false); // palabra completa
  assert.equal(mencionaTema('dólar blue', 'Sube el dolar'), true); // sin tildes
});

test('relevanciaDe: libres usan al juez; sin juez, el título; oficiales, categoría y subtema', () => {
  assert.equal(relevanciaDe(reg('milei', { juez: 'NO' })), 'NO');
  assert.equal(relevanciaDe(reg('milei', { juez: null }, { mencionaEnTitulo: true })), 'SI');
  assert.equal(relevanciaDe(reg('milei', { juez: null }, { mencionaEnTitulo: false, menciona: true })), 'PARCIAL');
  assert.equal(relevanciaDe(reg('milei', { juez: null }, { mencionaEnTitulo: false, menciona: false })), 'NO');
  assert.equal(relevanciaDe(reg('Fútbol', { tipo: 'oficial', nivel: 'subtema' })), 'SI');
  assert.equal(relevanciaDe(reg('Fútbol', { tipo: 'oficial', nivel: 'subtema' }, { subtemaOk: false })), 'PARCIAL');
  assert.equal(relevanciaDe(reg('Fútbol', { tipo: 'oficial', nivel: 'subtema' }, { categoriaOk: false })), 'NO');
  assert.equal(relevanciaDe(reg('Deportes', { tipo: 'oficial', nivel: 'categoria' })), 'SI');
  assert.equal(relevanciaDe(reg('milei', { rescate: true })), null);
});

test('particion: los 5 destinos posibles', () => {
  assert.equal(particion(reg('a', { juez: 'SI' })), 'tema_si');
  assert.equal(particion(reg('a', { juez: 'PARCIAL' })), 'tema_parcial');
  assert.equal(particion(reg('a', { juez: 'NO' })), 'tema_no');
  assert.equal(particion(reg('a', { rescate: true, zona: 'RESCATE' })), 'rescate');
  assert.equal(particion(reg('a', { entregada: false })), 'sin_noticia');
});

// ---------------------------------------------------------------- resumen y comparación

test('resumir: cuenta, porcentajes, edades y zonas', () => {
  const r = resumir([
    reg('a', {}, { edadHoras: 2 }), reg('b', {}, { edadHoras: 10 }), reg('c', { rescate: true, zona: 'RESCATE' }, { edadHoras: 30 }),
    reg('d', { entregada: false, zona: null }), reg('e', { juez: 'NO' }, { edadHoras: 40 }),
  ]);
  assert.equal(r.n, 5);
  assert.equal(r.cuenta.tema_si, 2);
  assert.equal(r.cuenta.rescate, 1);
  assert.equal(r.cuenta.sin_noticia, 1);
  assert.equal(r.cuenta.tema_no, 1);
  assert.equal(r.pct.tema_si, 40);
  assert.equal(r.edad.mediana, 10); // solo noticias "en tema": 2, 10, 40
  assert.equal(r.zonas.RESCATE, 1);
  assert.equal(r.zonas.ninguna, 1);
});

test('resumir: cuenta la zona ETIQUETA, las edades (ideal y tope) y la sustancia de lo entregado', () => {
  const r = resumir([
    reg('Fútbol', { tipo: 'oficial', nivel: 'subtema', zona: 'ETIQUETA', scoreBusqueda: null }, { edadHoras: 3, importancia: 80 }),
    reg('Economía', { tipo: 'oficial', nivel: 'categoria', zona: 'ETIQUETA', scoreBusqueda: null }, { edadHoras: 10, importancia: 45 }),
    reg('x', {}, { edadHoras: 20, importancia: 55 }),
    reg('y', {}, { edadHoras: 26, importancia: 30 }),
    reg('z', { rescate: true, zona: 'RESCATE' }, { edadHoras: 5, importancia: 90 }),
  ]);
  assert.equal(r.zonas.ETIQUETA, 2);
  assert.equal(r.edad.n, 4, 'el rescate no cuenta como "en tema"');
  assert.equal(r.edad.pctHasta10, 50, '3 y 10 h de [3, 10, 20, 26]');
  assert.equal(r.edad.pctHasta24, 75);
  assert.equal(r.edad.pctMasDe24, 25);
  assert.equal(r.edad.maxTodas, 26);
  assert.deepEqual(r.sustancia, { n: 4, mediana: 45, pctBuenas: 50, pctBajoElPiso: 25 });
  assert.equal(resumir([reg('a')]).sustancia.n, 0, 'una corrida sin importancia no inventa datos');
});

test('compararVersiones: mejora, regresión, cambia e igual', () => {
  const mismaUrl = 'https://x.test/misma';
  const A = corrida([
    reg('rescatado', { rescate: true, zona: 'RESCATE' }),
    reg('empeora', { juez: 'SI' }),
    reg('mismo', {}, { url: mismaUrl }),
    reg('cambia', { juez: 'SI' }),
  ]);
  const B = corrida([
    reg('rescatado', { juez: 'SI' }),
    reg('empeora', { rescate: true, zona: 'RESCATE' }),
    reg('mismo', {}, { url: mismaUrl }),
    reg('cambia', { juez: 'SI' }),
  ]);
  const estado = Object.fromEntries(compararVersiones(A, B).map((f) => [f.tema, f.estado]));
  assert.deepEqual(estado, { rescatado: 'mejora', empeora: 'regresion', mismo: 'igual', cambia: 'cambia' });
});

test('compararVersiones: ignora temas que están solo en una corrida', () => {
  const filas = compararVersiones(corrida([reg('solo antes')]), corrida([reg('solo despues')]));
  assert.equal(filas.length, 0);
});

test('soloEnComun: compara únicamente los temas presentes en las dos corridas', () => {
  const A = corrida([reg('a'), reg('b'), reg('Fútbol', { tipo: 'oficial', nivel: 'subtema' })]);
  const B = corrida([reg('a'), reg('c')]);
  const c = soloEnComun(A, B);
  assert.deepEqual(c.A.resultados.map((r) => r.tema), ['a']);
  assert.deepEqual(c.B.resultados.map((r) => r.tema), ['a']);
  assert.equal(c.excluidosA, 2);
  assert.equal(c.excluidosB, 1);
});

// ---------------------------------------------------------------- cordura y veredicto

test('chequeosCordura: detecta noticias de más de 24 h, categoría equivocada y corral violado', () => {
  const A = corrida([reg('a')]);
  const mala = corrida([
    reg('Fútbol', { tipo: 'oficial', nivel: 'subtema' }, { categoriaOk: false }),
    reg('x', { corral: 'Deportes' }, { categoria: 'Sociedad', edadHoras: 60 }),
  ]);
  const fallos = chequeosCordura(A, mala).filter((c) => !c.ok && c.nivel === 'error').map((c) => c.nombre);
  assert.ok(fallos.some((f) => /24 h/.test(f)));
  assert.ok(fallos.some((f) => /categoría pedida/.test(f)));
  assert.ok(fallos.some((f) => /corral/.test(f)));
});

test('chequeosCordura: todo en orden', () => {
  const A = corrida([reg('a')]);
  const B = corrida([reg('a')]);
  assert.deepEqual(chequeosCordura(A, B).filter((c) => !c.ok), []);
});

test('chequeosCordura: el tope de 24 h rige para la versión nueva; la anterior podía llegar a 48 h', () => {
  const edad = (A, B) => chequeosCordura(A, B).find((c) => /no entrega noticias de más de 24 h/.test(c.nombre));
  const vieja = corrida([reg('a', {}, { edadHoras: 47 })]);
  const dentro = edad(vieja, corrida([reg('a', {}, { edadHoras: 23.9 })]));
  assert.equal(dentro.ok, true, 'que la anterior llegara a 47 h no es una falla');
  assert.match(dentro.detalle, /antes 47 h \(el código anterior permitía hasta 48 h\), después 23\.9 h/);
  assert.equal(edad(vieja, corrida([reg('a', {}, { edadHoras: 30 })])).ok, false, 'una nota de 30 h en la nueva sí');
  assert.equal(edad(vieja, corrida([reg('a', {}, { edadHoras: 24.4 })])).ok, true, 'medio punto de tolerancia por el reloj entre la base y la corrida');
});

test('chequeosCordura: piso de importancia (40; el rescate, 50) y país en Sociedad; sin esos datos no se miden', () => {
  const A = corrida([reg('a')]);
  const piso = (B) => chequeosCordura(A, B).find((c) => /piso de importancia/.test(c.nombre));
  const pais = (B) => chequeosCordura(A, B).find((c) => /Sociedad solo/.test(c.nombre));
  const rescate = (importancia) => corrida([reg('a', { rescate: true, zona: 'RESCATE' }, { importancia })]);

  assert.equal(piso(corrida([reg('a', {}, { importancia: 40 })])).ok, true, '40 justo vale');
  assert.equal(piso(corrida([reg('a', {}, { importancia: 39 })])).ok, false);
  assert.equal(piso(rescate(49)).ok, false, 'el rescate pide 50');
  assert.equal(piso(rescate(50)).ok, true);
  assert.match(piso(corrida([reg('a', {}, { importancia: 10 })])).detalle, /a \(10\)/);
  assert.equal(piso(corrida([reg('a')])), undefined, 'una corrida sin datos de importancia no se mide');

  const sociedad = (geoScope) => corrida([reg('a', {}, { categoria: 'Sociedad', geoScope })]);
  assert.equal(pais(sociedad('Argentina')).ok, true);
  assert.equal(pais(sociedad('GLOBAL')).ok, true);
  assert.equal(pais(sociedad('España')).ok, false);
  assert.match(pais(sociedad('España')).detalle, /a \(España\)/);
  assert.equal(pais(corrida([reg('a', {}, { categoria: 'Deportes', geoScope: 'Brasil' })])), undefined, 'la regla es solo de Sociedad');
  assert.equal(pais(corrida([reg('a', {}, { categoria: 'Sociedad' })])), undefined, 'sin alcance guardado no se mide');
});

test('chequeosCordura: la deriva de la base se mide con las notas de 24 h si las dos corridas las guardaron', () => {
  const deriva = (a, b) => chequeosCordura(corrida([reg('a')], a), corrida([reg('a')], b)).find((c) => /deriva/.test(c.nombre));
  const con24 = deriva({ dbArticulos24h: 100 }, { dbArticulos24h: 110 });
  assert.equal(con24.ok, false);
  assert.match(con24.detalle, /últimas 24 h: antes 100, después 110/);
  const sin24 = deriva({ dbArticulos48h: 1000 }, { dbArticulos48h: 1005 });
  assert.equal(sin24.ok, true);
  assert.match(sin24.detalle, /últimas 48 h/);
  assert.match(deriva({ dbArticulos24h: 100 }, {}).detalle, /últimas 48 h/, 'si a una corrida le falta el dato de 24 h, se usa el de 48 h');
});

function escenario(antes, despues) {
  const A = corrida(antes);
  const B = corrida(despues);
  const por = (R, tipo) => resumir(R.resultados.filter((r) => r.tipo === tipo));
  const resA = { oficiales: por(A, 'oficial'), libres: por(A, 'libre') };
  const resB = { oficiales: por(B, 'oficial'), libres: por(B, 'libre') };
  const filas = compararVersiones(A, B);
  return {
    A, B, resA, resB, filas, cordura: chequeosCordura(A, B),
    veredicto: veredicto(resA, resB, filas.filter((f) => f.tipo === 'libre'), filas.filter((f) => f.tipo === 'oficial')),
    temasInfo: { origenLibres: 'prueba' },
  };
}

test('veredicto: MEJORA cuando baja el rescate y sube lo que está en tema', () => {
  const e = escenario(
    [reg('a', { rescate: true, zona: 'RESCATE' }), reg('b', { rescate: true, zona: 'RESCATE' }), reg('c')],
    [reg('a'), reg('b'), reg('c')]
  );
  assert.equal(e.veredicto.global, 'MEJORA');
});

test('veredicto: EMPEORA cuando más temas caen a rescate', () => {
  const e = escenario(
    [reg('a'), reg('b'), reg('c')],
    [reg('a', { rescate: true, zona: 'RESCATE' }), reg('b', { rescate: true, zona: 'RESCATE' }), reg('c')]
  );
  assert.equal(e.veredicto.global, 'EMPEORA');
});

test('veredicto: SIN CAMBIOS si todo da igual', () => {
  const mismas = [reg('a', {}, { url: 'https://x.test/1' }), reg('b', {}, { url: 'https://x.test/2' })];
  const e = escenario(mismas, mismas.map((r) => ({ ...r })));
  assert.equal(e.veredicto.global, 'SIN CAMBIOS');
});

test('veredicto: si no hay temas oficiales en la comparación, no inventa fallas de oficiales', () => {
  const A = corrida([reg('a'), reg('b')]);
  const B = corrida([reg('a'), reg('b')]);
  const por = (R, tipo) => resumir(R.resultados.filter((r) => r.tipo === tipo));
  const v = veredicto({ oficiales: por(A, 'oficial'), libres: por(A, 'libre') }, { oficiales: por(B, 'oficial'), libres: por(B, 'libre') }, [], []);
  assert.ok(!v.checks.some((c) => /Oficiales/.test(c.nombre)));
  assert.notEqual(v.global, 'EMPEORA');
});

test('veredicto: diferencias de unos pocos milisegundos no disparan la alarma de velocidad', () => {
  const A = corrida([reg('a', { ms: 2 })]);
  const B = corrida([reg('a', { ms: 7 })]);
  const por = (R, tipo) => resumir(R.resultados.filter((r) => r.tipo === tipo));
  const v = veredicto({ oficiales: por(A, 'oficial'), libres: por(A, 'libre') }, { oficiales: por(B, 'oficial'), libres: por(B, 'libre') }, [], []);
  assert.equal(v.checks.find((c) => /Velocidad/.test(c.nombre)).estado, 'igual');
});

test('veredicto: la frescura se mide en los mismos temas (pareada), no entre conjuntos distintos', () => {
  const por = (R, tipo) => resumir(R.resultados.filter((r) => r.tipo === tipo));
  const correr = (A, B) => {
    const filas = compararVersiones(A, B);
    return veredicto({ oficiales: por(A, 'oficial'), libres: por(A, 'libre') }, { oficiales: por(B, 'oficial'), libres: por(B, 'libre') },
      filas.filter((f) => f.tipo === 'libre'), []).checks.find((c) => /Frescura/.test(c.nombre));
  };
  // la nueva entrega una nota más fresca en los dos temas
  const mejor = correr(corrida([reg('a', {}, { edadHoras: 30 }), reg('b', {}, { edadHoras: 20 })]),
    corrida([reg('a', {}, { edadHoras: 5 }), reg('b', {}, { edadHoras: 8 })]));
  assert.equal(mejor.estado, 'ok');
  // la nueva entrega notas más viejas
  const peor = correr(corrida([reg('a', {}, { edadHoras: 5 })]), corrida([reg('a', {}, { edadHoras: 30 })]));
  assert.equal(peor.estado, 'aviso');
  // temas rescatados no entran en la comparación de frescura
  const rescate = correr(corrida([reg('a', { rescate: true, zona: 'RESCATE' }, { edadHoras: 1 })]), corrida([reg('a', {}, { edadHoras: 40 })]));
  assert.equal(rescate, undefined);
});

test('veredicto: vigencia — mejora si el código anterior pasaba las 24 h y el nuevo no; falla si el nuevo se pasa', () => {
  const por = (R, tipo) => resumir(R.resultados.filter((r) => r.tipo === tipo));
  const vigencia = (A, B) => veredicto({ oficiales: por(A, 'oficial'), libres: por(A, 'libre') }, { oficiales: por(B, 'oficial'), libres: por(B, 'libre') }, [], [])
    .checks.find((c) => /Vigencia/.test(c.nombre));
  const con = (h) => corrida([reg('a', {}, { edadHoras: h })]);
  assert.equal(vigencia(con(40), con(20)).estado, 'ok');
  assert.match(vigencia(con(40), con(20)).detalle, /antes 40 h → después 20 h/);
  assert.equal(vigencia(con(20), con(20)).estado, 'igual');
  assert.equal(vigencia(con(20), con(25)).estado, 'mal');
  assert.equal(vigencia(corrida([]), corrida([])), undefined, 'sin noticias no hay nada que medir');
});

test('veredicto: la sustancia (importancia de 50 o más) solo avisa si baja, y no se mide sin datos', () => {
  const por = (R, tipo) => resumir(R.resultados.filter((r) => r.tipo === tipo));
  const sustancia = (A, B) => veredicto({ oficiales: por(A, 'oficial'), libres: por(A, 'libre') }, { oficiales: por(B, 'oficial'), libres: por(B, 'libre') }, [], [])
    .checks.find((c) => /buenas/.test(c.nombre));
  const con = (importancia) => corrida([reg('a', {}, { importancia })]);
  assert.equal(sustancia(con(45), con(70)).estado, 'ok');
  assert.equal(sustancia(con(70), con(70)).estado, 'igual');
  assert.equal(sustancia(con(70), con(45)).estado, 'aviso');
  assert.equal(sustancia(corrida([reg('a')]), corrida([reg('a')])), undefined);
});

// ---------------------------------------------------------------- reporte

test('reporte: HTML, CSV y consola se generan y escapan el HTML de los títulos', () => {
  const peligrosa = reg('a', {}, { titulo: '<script>alert(1)</script> & "comillas"' });
  const e = escenario([reg('a', { rescate: true, zona: 'RESCATE' })], [peligrosa]);
  const html = htmlReporte(e);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  const csv = csvComparacion(e.filas);
  assert.ok(csv.split('\n')[0].includes('antes_resultado'));
  assert.ok(csv.includes('""comillas""'));
  // CSV: un título que empieza con "=" no debe interpretarse como fórmula; un link no-http no se vuelve <a>
  const formula = escenario([reg('a')], [reg('a', {}, { titulo: '=HYPERLINK("x")', url: 'javascript:alert(1)' })]);
  assert.ok(csvComparacion(formula.filas).includes('"\'=HYPERLINK'));
  assert.ok(!htmlReporte(formula).includes('href="javascript:'));
  const txt = textoConsola(e);
  assert.match(txt, /VEREDICTO SUGERIDO/);
});

test('reporte: muestra la zona ETIQUETA, la edad ideal, la vigencia y la sustancia; el CSV trae importancia y nivel', () => {
  const antes = reg('Fútbol', { tipo: 'oficial', nivel: 'subtema' }, { edadHoras: 40, importancia: 60 });
  const despues = reg('Fútbol', { tipo: 'oficial', nivel: 'subtema', zona: 'ETIQUETA', scoreBusqueda: null, nivelNota: 'buena' }, { edadHoras: 4, importancia: 72 });
  const e = escenario([antes], [despues]);
  const html = htmlReporte(e);
  for (const frag of ['Zona ETIQUETA', 'Hasta 10 h, lo ideal', 'Más de 24 h', 'Buenas, de importancia 50 o más', 'imp. 72 (buena)', 'Vigencia: ninguna noticia de más de 24 h']) {
    assert.ok(html.includes(frag), `falta "${frag}" en el HTML`);
  }
  assert.doesNotMatch(html, /undefined|NaN|\[object/);

  const csv = csvComparacion(e.filas);
  assert.ok(csv.split('\n')[0].endsWith('antes_importancia;despues_importancia;despues_nivel'));
  assert.ok(csv.includes('"60";"72";"buena"'));

  const txt = textoConsola(e);
  assert.match(txt, /Hasta 10 h \(lo ideal\)/);
  assert.match(txt, /Buenas \(importancia 50\+\)/);
  assert.match(txt, /Vigencia: ninguna noticia de más de 24 h/);
});

test('reporte: una corrida sin datos de importancia no muestra el bloque de sustancia ni celdas rotas', () => {
  const e = escenario([reg('a')], [reg('a')]);
  const html = htmlReporte(e);
  assert.ok(!html.includes('Sustancia de la noticia entregada'));
  assert.doesNotMatch(html, /undefined|NaN|\[object/);
});

// ---------------------------------------------------------------- temas

test('verificarOficialesContraCodigo: lee la taxonomía de officialTopics.js (motor nuevo) o de pickBestArticlePerTopic.js (anterior)', () => {
  const nombres = temasOficiales().map((t) => `'${t.tema}'`).join(', ');
  const dirs = [];
  const armar = (archivos) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oficiales-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, 'src', 'utils'), { recursive: true });
    for (const [nombre, texto] of Object.entries(archivos)) fs.writeFileSync(path.join(root, 'src', 'utils', nombre), texto);
    return root;
  };
  try {
    const nuevo = armar({ 'pickBestArticlePerTopic.js': '// la lista vive en officialTopics.js', 'officialTopics.js': `const T = [${nombres}];` });
    assert.deepEqual(verificarOficialesContraCodigo(nuevo).faltantes, []);

    const anterior = armar({ 'pickBestArticlePerTopic.js': `const T = [${nombres}];` });
    assert.deepEqual(verificarOficialesContraCodigo(anterior).faltantes, []);

    const desactualizado = armar({ 'pickBestArticlePerTopic.js': '// sin lista', 'officialTopics.js': "const T = ['Fútbol'];" });
    const faltantes = verificarOficialesContraCodigo(desactualizado).faltantes;
    assert.equal(faltantes.length, temasOficiales().length - 1);
    assert.ok(!faltantes.includes('Fútbol'));

    assert.equal(verificarOficialesContraCodigo(path.join(os.tmpdir(), 'no-existe-oficiales-xyz')).faltantes, null);
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('temas oficiales: 7 categorías + sus subtemas, sin repetidos', () => {
  const t = temasOficiales();
  assert.equal(t.filter((x) => x.nivel === 'categoria').length, 7);
  assert.equal(new Set(t.map((x) => x.tema)).size, t.length);
  assert.ok(t.every((x) => x.categoria));
});

test('construirTemas: manual, sin oficiales ni duplicados, y --rapido recorta', async () => {
  const r = await construirTemas({ libresManual: ['River Plate', 'river  plate', 'Fútbol', 'milei', ''] });
  assert.deepEqual(r.libres.map((l) => l.tema), ['River Plate', 'milei']); // "Fútbol" es oficial
  const rapido = await construirTemas({ libresManual: Array.from({ length: 40 }, (_, i) => `tema ${i}`), rapido: true });
  assert.equal(rapido.libres.length, 15);
  assert.ok(rapido.oficiales.length < temasOficiales().length);
});

test('construirTemas: sin datos usa la lista de ejemplo y lo avisa', async () => {
  const r = await construirTemas({});
  assert.ok(r.libres.length > 10);
  assert.match(r.origenLibres, /ejemplo/);
});
