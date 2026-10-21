'use strict';

/**
 * Niveles de carga, umbrales y cantidades del test de estrés.
 * Las cantidades que usan los escenarios y las que muestra --dry-run salen de
 * las MISMAS funciones (tamanios / tareasEscalon), así el plan no puede mentir.
 */

const { MAX_ARTICLE_AGE_HOURS } = require('../../utils/freshness');
const { VERDE_MIN, AMARILLA_MIN } = require('../../utils/topicMatching');
const {
  SAME_STORY_COSINE, HISTORY_MAX_NOTES, HISTORY_WINDOW_HOURS, IMPORTANCE_GOOD_MIN, IMPORTANCE_ACCEPTABLE_MIN,
} = require('../../utils/eligibility');

const NIVELES = {
  suave: {
    nombre: 'suave',
    descripcion: 'Humo rápido: confirma que todo corre y da una primera señal (unos minutos).',
    oficiales: 'categorias', libres: 10, concurrencia: 2,
    A: { repeticiones: 3 },
    B: { temas: 6, rondas: 4, sesiones: 2, rondasSesion: 6 },
    C: { triplas: 3, repeticiones: 2, permutar: false },
    D: { rampa: [1, 2, 4], tareasMin: 8, tareasPorWorker: 2, mega: 10, lock: 5, stampede: 6 },
    E: { hostiles: 'basicos', variantes: 4, repeticiones: 1 },
    F: { minutos: 0 },
    timeoutS: 60, maxOpenAI: 1500, maxMinutos: 15,
  },
  medio: {
    nombre: 'medio',
    descripcion: 'Carga realista alta: todos los oficiales, 40 libres, rampa hasta 16 en paralelo.',
    oficiales: 'todos', libres: 40, concurrencia: 4,
    A: { repeticiones: 5 },
    B: { temas: 20, rondas: 8, sesiones: 6, rondasSesion: 12 },
    C: { triplas: 10, repeticiones: 3, permutar: true },
    D: { rampa: [1, 2, 4, 8, 16], tareasMin: 20, tareasPorWorker: 3, mega: 30, lock: 10, stampede: 15 },
    E: { hostiles: 'todos', variantes: 15, repeticiones: 2 },
    F: { minutos: 0 },
    timeoutS: 60, maxOpenAI: 12000, maxMinutos: 45,
  },
  maximo: {
    nombre: 'maximo',
    descripcion: 'Estrés máximo: 150 libres, 10 repeticiones, rampa hasta 64 en paralelo y 10 min de soak.',
    oficiales: 'todos', libres: 150, concurrencia: 8,
    A: { repeticiones: 10 },
    B: { temas: 40, rondas: 12, sesiones: 15, rondasSesion: 14 },
    C: { triplas: 25, repeticiones: 3, permutar: true },
    D: { rampa: [1, 2, 4, 8, 16, 32, 64], tareasMin: 30, tareasPorWorker: 3, mega: 100, lock: 25, stampede: 30 },
    E: { hostiles: 'todos', variantes: 40, repeticiones: 3 },
    F: { minutos: 10 },
    timeoutS: 90, maxOpenAI: 60000, maxMinutos: 120,
  },
};

// Cuándo se considera que el sistema "se quebró" y se deja de subir la rampa.
const UMBRALES = {
  errorRateQuiebre: 0.10,   // llamadas con error/timeout o con error_busqueda tragado
  p95FraccionTimeout: 0.5,  // p95 por encima de esta fracción del timeout
  lagP99Ms: 500,            // retraso del event loop
  degradacionP95: 4,        // p95 del escalón / p95 del escalón 1
  rescateMaxLibres: 0.35,   // % tolerable de tópicos libres resueltos por rescate
  memoriaMBporMin: 20,      // crecimiento de heap sostenido en el soak
  casiDuplicadoCos: SAME_STORY_COSINE, // el mismo umbral con que el motor descarta "la misma historia"
  casiDuplicadoTitulos: 0.6,
};

const CONTRATO = {
  maxEdadHoras: MAX_ARTICLE_AGE_HOURS,
  verdeMin: VERDE_MIN,
  amarillaMin: AMARILLA_MIN,
  ventanaHistorial: HISTORY_MAX_NOTES,     // getAlreadyShownHistoryForUser: hasta 150 notas...
  ventanaHistorialHoras: HISTORY_WINDOW_HOURS, // ...de las últimas 48 h
  importanciaBuena: IMPORTANCE_GOOD_MIN,       // >= 50: nota "buena" (y mínimo del rescate)
  importanciaMinima: IMPORTANCE_ACCEPTABLE_MIN, // >= 40: nada por debajo se entrega
  topicosPorUsuario: 3,     // UserPreference.topics: exactamente 3
  perTopicLimit: 10,        // igual que buildUserNewsDigest
};

const SEVERIDADES = ['CRITICA', 'ALTA', 'MEDIA', 'BAJA', 'INFO'];

// ---------------------------------------------------------------- hostiles
const rep = (txt, n) => Array.from({ length: n }, () => txt).join(' ');

const HOSTILES = [
  { id: 'vacio', grupo: 'vacios', basico: true, valor: '' },
  { id: 'espacios', grupo: 'vacios', basico: true, valor: '   ' },
  { id: 'saltos', grupo: 'vacios', valor: '\n\t \r\n' },
  { id: 'null', grupo: 'no_string', basico: true, valor: null },
  { id: 'undefined', grupo: 'no_string', valor: undefined },
  { id: 'numero', grupo: 'no_string', valor: 12345 },
  { id: 'objeto', grupo: 'no_string', valor: { a: 1 } },
  { id: 'array_vacio', grupo: 'no_string', valor: [] },
  { id: 'un_caracter', grupo: 'extremos', basico: true, valor: 'a' },
  { id: 'dos_caracteres', grupo: 'extremos', valor: 'ab' },
  { id: 'cuarenta', grupo: 'extremos', valor: 'a'.repeat(40) },
  { id: 'largo_500', grupo: 'extremos', basico: true, valor: rep('palabra', 70) },
  { id: 'largo_5000', grupo: 'extremos', valor: 'x'.repeat(5000) },
  { id: 'muchas_palabras', grupo: 'extremos', valor: Array.from({ length: 60 }, (_, i) => `palabra${i}`).join(' ') },
  { id: 'emoji', grupo: 'unicode', basico: true, valor: '⚽🔥' },
  { id: 'bandera', grupo: 'unicode', valor: '🇦🇷' },
  { id: 'ancho_cero', grupo: 'unicode', valor: 'river​ plate' },
  { id: 'arabe', grupo: 'unicode', valor: 'مرحبا بالعالم' },
  { id: 'japones', grupo: 'unicode', valor: '日本 サッカー' },
  { id: 'caracter_nul', grupo: 'unicode', valor: 'river\u0000plate' },
  { id: 'acento_combinado', grupo: 'unicode', valor: 'rivér plate' },
  { id: 'regex', grupo: 'inyeccion', basico: true, valor: '.*' },
  { id: 'regex_grupo', grupo: 'inyeccion', valor: '(a|b)+[' },
  { id: 'barra', grupo: 'inyeccion', valor: '\\' },
  { id: 'mongo_operador', grupo: 'inyeccion', basico: true, valor: '{"$ne": null}' },
  { id: 'mongo_where', grupo: 'inyeccion', valor: '$where: sleep(1000)' },
  { id: 'html', grupo: 'inyeccion', valor: '<script>alert(1)</script>' },
  { id: 'sql', grupo: 'inyeccion', valor: "'; DROP TABLE articles; --" },
  { id: 'lucene', grupo: 'inyeccion', valor: 'title:* AND (a OR b) -c "d' },
  { id: 'proto', grupo: 'prototipo', basico: true, valor: '__proto__' },
  { id: 'constructor', grupo: 'prototipo', basico: true, valor: 'constructor' },
  { id: 'tostring', grupo: 'prototipo', valor: 'toString' },
  { id: 'hasownproperty', grupo: 'prototipo', valor: 'hasOwnProperty' },
  { id: 'valueof', grupo: 'prototipo', valor: 'valueOf' },
  { id: 'solo_stopwords', grupo: 'ruido', basico: true, valor: 'el la los de del' },
  { id: 'solo_numeros', grupo: 'ruido', valor: '2026' },
  { id: 'signos', grupo: 'ruido', valor: '!!! ??? ...' },
  { id: 'repetida', grupo: 'ruido', valor: rep('river', 5) },
  { id: 'palabra_inventada', grupo: 'ruido', basico: true, valor: 'qzxvbnm' },
  { id: 'frase_inventada', grupo: 'ruido', valor: 'asdkjh qweoiu zxcmnb' },
  { id: 'texto_null', grupo: 'ruido', valor: 'null' },
  { id: 'texto_undefined', grupo: 'ruido', valor: 'undefined' },
];

function hostilesDe(modo) {
  return modo === 'todos' ? HOSTILES : HOSTILES.filter((h) => h.basico);
}

/** Para mostrar en reportes (JSON no soporta undefined ni objetos raros). */
function describirValor(v) {
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return v.length > 60 ? `${JSON.stringify(v.slice(0, 40))}… (${v.length} car.)` : JSON.stringify(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** Variantes de escritura de un mismo tópico: deberían dar lo mismo. */
function variantesDe(tema) {
  const t = String(tema || '').trim();
  const sinAcentos = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const capitalizado = t.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_, sp, c) => sp + c.toUpperCase());
  const lista = [
    { id: 'original', valor: t },
    { id: 'minusculas', valor: t.toLowerCase() },
    { id: 'MAYUSCULAS', valor: t.toUpperCase() },
    { id: 'Capitalizado', valor: capitalizado },
    { id: 'sin_acentos', valor: sinAcentos },
  ];
  const vistos = new Set();
  return lista.filter((v) => (vistos.has(v.valor) ? false : vistos.add(v.valor)));
}

// ---------------------------------------------------------------- overrides de la línea de comandos
const entero = (v, def) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};

/** Copia del nivel con los overrides del CLI aplicados (--repeticiones, --rondas, --rampa, …). */
function resolverNivel(nombre, args = {}) {
  const base = NIVELES[nombre];
  if (!base) throw new Error(`Nivel desconocido "${nombre}". Opciones: ${Object.keys(NIVELES).join(', ')}`);
  const n = JSON.parse(JSON.stringify(base));
  if (args.repeticiones) n.A.repeticiones = entero(args.repeticiones, n.A.repeticiones);
  if (args.rondas) { n.B.rondas = entero(args.rondas, n.B.rondas); n.B.rondasSesion = entero(args.rondas, n.B.rondasSesion); }
  if (args.libres) n.libres = entero(args.libres, n.libres);
  if (args.concurrencia) n.concurrencia = entero(args.concurrencia, n.concurrencia);
  if (args.timeout) n.timeoutS = entero(args.timeout, n.timeoutS);
  if (args['max-openai']) n.maxOpenAI = entero(args['max-openai'], n.maxOpenAI);
  if (args['max-minutos']) n.maxMinutos = entero(args['max-minutos'], n.maxMinutos);
  if (args['soak-minutos'] !== undefined) n.F.minutos = Math.max(0, Number(args['soak-minutos']) || 0);
  if (args.rampa) {
    const rampa = String(args.rampa).split(',').map((x) => entero(x, 0)).filter(Boolean);
    if (rampa.length) n.D.rampa = rampa;
  }
  if (args['concurrencia-max']) {
    const tope = entero(args['concurrencia-max'], Infinity);
    const recortada = n.D.rampa.filter((c) => c <= tope);
    n.D.rampa = recortada.length ? recortada : [1];
  }
  return n;
}

// ---------------------------------------------------------------- tamaños
const CALENTAMIENTO_TOPICOS = 30; // tópicos distintos que usa la rampa (se precalientan las expansiones)

const tareasEscalon = (nivel, c) => Math.max(nivel.D.tareasMin, nivel.D.tareasPorWorker * c);

function tamanios(nivel, { oficiales, libres, usuarios, hostiles }) {
  const nTemasA = oficiales + libres;
  const nTemasB = Math.min(nivel.B.temas, nTemasA);
  const permutaciones = nivel.C.permutar ? 6 : 1;
  const pasosRampa = nivel.D.rampa.reduce((acc, c) => acc + tareasEscalon(nivel, c), 0);
  const conUsuarios = usuarios > 0;
  const calentamiento = Math.min(CALENTAMIENTO_TOPICOS, nTemasA);
  const digests = conUsuarios ? pasosRampa + nivel.D.tareasMin + nivel.D.lock * 2 + 1 : 0;
  return {
    A: { picks: nTemasA * nivel.A.repeticiones, busquedas: nTemasA * nivel.A.repeticiones },
    B: {
      picks: nTemasB * nivel.B.rondas + nivel.B.sesiones * nivel.B.rondasSesion,
      busquedas: nTemasB * nivel.B.rondas + nivel.B.sesiones * nivel.B.rondasSesion * CONTRATO.topicosPorUsuario,
    },
    C: {
      picks: nivel.C.triplas * permutaciones * nivel.C.repeticiones,
      busquedas: nivel.C.triplas * permutaciones * nivel.C.repeticiones * CONTRATO.topicosPorUsuario,
    },
    D: {
      picks: pasosRampa + calentamiento + nivel.D.stampede + 1,
      digests,
      busquedas: pasosRampa + calentamiento + nivel.D.stampede + nivel.D.mega + digests * CONTRATO.topicosPorUsuario,
    },
    E: {
      picks: hostiles * nivel.E.repeticiones + Math.min(nivel.E.variantes, libres) * 5,
      busquedas: hostiles * nivel.E.repeticiones + Math.min(nivel.E.variantes, libres) * 5,
    },
  };
}

module.exports = {
  NIVELES, UMBRALES, CONTRATO, SEVERIDADES, HOSTILES, CALENTAMIENTO_TOPICOS,
  hostilesDe, describirValor, variantesDe, resolverNivel, tareasEscalon, tamanios,
};
