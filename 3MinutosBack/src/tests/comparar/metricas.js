'use strict';

/**
 * Métricas y comparación antes/después. TODO acá es lógica pura (sin Mongo ni OpenAI),
 * así se puede probar con archivos JSON de resultados.
 *
 * Cada tema termina en UNA de estas 5 categorías (la "partición"), de mejor a peor:
 *   tema_si       -> entregó una noticia que trata del tema
 *   tema_parcial  -> entregó una noticia que lo menciona sin ser el foco
 *                    (en oficiales: la categoría es correcta pero el subtema es otro)
 *   rescate       -> no encontró nada y mostró una "noticia sugerida" (avisa al usuario)
 *   sin_noticia   -> no entregó nada
 *   tema_no       -> entregó como si fuera del tema una noticia que NO lo es (falla silenciosa)
 */

const { norm, redondear } = require('./utilidades');

const MAX_EDAD_HORAS = 48;

// Mismas palabras funcionales que topicMatching.js (solo gramática, sin nombres propios).
const PALABRAS_FUNCIONALES = new Set([
  'del', 'los', 'las', 'una', 'uno', 'unos', 'unas', 'con', 'sin', 'por', 'para',
  'que', 'como', 'sus', 'este', 'esta', 'esto', 'ese', 'esa', 'son', 'ser',
]);

const RANGO = { tema_si: 4, tema_parcial: 3, rescate: 2, sin_noticia: 1, tema_no: 0 };

const ETIQUETAS = {
  tema_si: 'En tema',
  tema_parcial: 'Parcial',
  rescate: 'Rescate (sugerida)',
  sin_noticia: 'Sin noticia',
  tema_no: 'Fuera de tema (silenciosa)',
};

// ---------------------------------------------------------------- texto

function tokens(texto) {
  return norm(texto).replace(/[^a-z0-9ñ]+/g, ' ').split(' ').filter(Boolean);
}

function palabrasTema(tema) {
  const vistas = new Set();
  return tokens(tema).filter((w) => {
    if (w.length < 3 || PALABRAS_FUNCIONALES.has(w) || vistas.has(w)) return false;
    vistas.add(w);
    return true;
  });
}

/**
 * Mención "laxa" e independiente de la lógica del producto: la frase completa, o al menos
 * la mitad de las palabras del tema, como palabras completas.
 */
function mencionaTema(tema, texto) {
  const palabras = palabrasTema(tema);
  const toks = tokens(texto);
  if (!palabras.length) return toks.join(' ').includes(tokens(tema).join(' '));
  const conjunto = new Set(toks);
  const frase = ` ${toks.join(' ')} `.includes(` ${tokens(tema).join(' ')} `);
  const aciertos = palabras.filter((w) => conjunto.has(w)).length;
  return frase || aciertos / palabras.length >= 0.5;
}

// ---------------------------------------------------------------- estadística

function percentil(valores, p) {
  const v = valores.filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[idx];
}

const porcentaje = (parte, total) => (total ? (100 * parte) / total : 0);

// ---------------------------------------------------------------- partición

/** SI | PARCIAL | NO para una noticia entregada como "del tema"; null si no aplica. */
function relevanciaDe(r) {
  if (!r.entregada || r.rescate || !r.articulo) return null;

  if (r.tipo === 'oficial') {
    if (!r.articulo.categoriaOk) return 'NO';
    if (r.nivel === 'subtema') return r.articulo.subtemaOk ? 'SI' : 'PARCIAL';
    return 'SI';
  }

  if (r.juez) return r.juez; // veredicto del juez IA
  if (r.articulo.mencionaEnTitulo) return 'SI'; // sin juez: heurística
  return r.articulo.menciona ? 'PARCIAL' : 'NO';
}

function particion(r) {
  if (!r.entregada) return 'sin_noticia';
  if (r.rescate) return 'rescate';
  const rel = relevanciaDe(r);
  if (rel === 'SI') return 'tema_si';
  if (rel === 'PARCIAL') return 'tema_parcial';
  return 'tema_no';
}

// ---------------------------------------------------------------- resumen por versión

function resumir(resultados) {
  const n = resultados.length;
  const cuenta = { tema_si: 0, tema_parcial: 0, rescate: 0, sin_noticia: 0, tema_no: 0 };
  const zonas = { VERDE: 0, AMARILLA: 0, RESCATE: 0, ninguna: 0 };
  const candidato = { '1': 0, '2': 0, '3+': 0, 'n/d': 0 };
  const edadesTema = [];
  const edadesTodas = [];
  const tiempos = [];
  let errores = 0;
  let usanJuez = 0;
  let libresEntregados = 0;

  for (const r of resultados) {
    cuenta[particion(r)]++;
    if (r.error) errores++;
    if (typeof r.ms === 'number') tiempos.push(r.ms);
    zonas[r.zona && zonas[r.zona] !== undefined ? r.zona : 'ninguna']++;

    if (r.entregada && r.articulo) {
      if (typeof r.articulo.edadHoras === 'number') {
        edadesTodas.push(r.articulo.edadHoras);
        if (!r.rescate) edadesTema.push(r.articulo.edadHoras);
      }
      if (!r.rescate && r.tipo === 'libre') {
        libresEntregados++;
        if (r.juez) usanJuez++;
      }
      if (!r.rescate) {
        const c = r.candidatosEvaluados;
        if (c === null || c === undefined) candidato['n/d']++;
        else if (c <= 1) candidato['1']++;
        else if (c === 2) candidato['2']++;
        else candidato['3+']++;
      }
    }
  }

  const bajo = (lista, horas) => porcentaje(lista.filter((e) => e <= horas).length, lista.length);

  return {
    n,
    cuenta,
    pct: Object.fromEntries(Object.entries(cuenta).map(([k, v]) => [k, porcentaje(v, n)])),
    zonas,
    candidato,
    errores,
    relevanciaConJuez: libresEntregados ? usanJuez / libresEntregados : null,
    edad: {
      n: edadesTema.length,
      mediana: redondear(percentil(edadesTema, 50)),
      p90: redondear(percentil(edadesTema, 90)),
      max: redondear(edadesTema.length ? Math.max(...edadesTema) : null),
      pctHasta6: redondear(bajo(edadesTema, 6)),
      pctHasta12: redondear(bajo(edadesTema, 12)),
      pctHasta24: redondear(bajo(edadesTema, 24)),
      pctMasDe36: redondear(porcentaje(edadesTema.filter((e) => e > 36).length, edadesTema.length)),
      maxTodas: redondear(edadesTodas.length ? Math.max(...edadesTodas) : null),
    },
    tiempo: { p50: percentil(tiempos, 50), p95: percentil(tiempos, 95) },
  };
}

// ---------------------------------------------------------------- mismo conjunto de temas

/**
 * Si las dos corridas no cubren los mismos temas (por ejemplo una con --solo libres), las
 * comparaciones se hacen SOLO sobre los temas que están en ambas; si no, los totales no son comparables.
 */
function soloEnComun(A, B) {
  const clave = (r) => `${r.tipo}|${norm(r.tema)}`;
  const ka = new Set(A.resultados.map(clave));
  const kb = new Set(B.resultados.map(clave));
  const comunes = new Set([...ka].filter((k) => kb.has(k)));
  return {
    A: { ...A, resultados: A.resultados.filter((r) => comunes.has(clave(r))) },
    B: { ...B, resultados: B.resultados.filter((r) => comunes.has(clave(r))) },
    excluidosA: ka.size - comunes.size,
    excluidosB: kb.size - comunes.size,
  };
}

// ---------------------------------------------------------------- comparación tema por tema

function indexar(resultados) {
  return new Map(resultados.map((r) => [`${r.tipo}|${norm(r.tema)}`, r]));
}

const urlDe = (r) => (r && r.articulo ? r.articulo.url : null);

function compararVersiones(A, B) {
  const porTemaA = indexar(A.resultados);
  const filas = [];

  for (const b of B.resultados) {
    const a = porTemaA.get(`${b.tipo}|${norm(b.tema)}`);
    if (!a) continue;

    const pa = particion(a);
    const pb = particion(b);
    const misma = urlDe(a) === urlDe(b);

    let estado;
    if (misma) estado = 'igual';
    else if (RANGO[pb] > RANGO[pa]) estado = 'mejora';
    else if (RANGO[pb] < RANGO[pa]) estado = 'regresion';
    else estado = 'cambia';

    const ea = a.articulo?.edadHoras;
    const eb = b.articulo?.edadHoras;
    filas.push({
      tema: b.tema,
      tipo: b.tipo,
      nivel: b.nivel,
      usuarios: b.usuarios ?? a.usuarios ?? null,
      antes: a,
      despues: b,
      pa,
      pb,
      estado,
      deltaRango: RANGO[pb] - RANGO[pa],
      deltaEdad: typeof ea === 'number' && typeof eb === 'number' && !a.rescate && !b.rescate ? redondear(eb - ea) : null,
    });
  }
  return filas;
}

function contarEstados(filas) {
  const c = { mejora: 0, regresion: 0, cambia: 0, igual: 0 };
  for (const f of filas) c[f.estado]++;
  return c;
}

// ---------------------------------------------------------------- chequeos de cordura

/** Cosas que tienen que cumplirse siempre; si fallan, hay un bug (no es cuestión de gusto). */
function chequeosCordura(A, B, extra = {}) {
  const items = [];
  const add = (nombre, ok, detalle, nivel = 'error') => items.push({ nombre, ok, detalle, nivel });

  const maxEdad = (R) => Math.max(0, ...R.resultados.map((r) => r.articulo?.edadHoras ?? 0));
  const eA = maxEdad(A);
  const eB = maxEdad(B);
  add(
    `Ninguna noticia supera las ${MAX_EDAD_HORAS} h`,
    eA <= MAX_EDAD_HORAS + 0.5 && eB <= MAX_EDAD_HORAS + 0.5,
    `máxima entregada: antes ${redondear(eA)} h, después ${redondear(eB)} h`
  );

  const malCat = (R) => R.resultados.filter((r) => r.tipo === 'oficial' && r.entregada && r.articulo && !r.articulo.categoriaOk);
  const mA = malCat(A);
  const mB = malCat(B);
  add(
    'Temas oficiales: la noticia es de la categoría pedida',
    mA.length === 0 && mB.length === 0,
    mA.length || mB.length
      ? `fuera de categoría: antes ${mA.length}, después ${mB.length} (${[...mA, ...mB].slice(0, 3).map((r) => r.tema).join(', ')})`
      : 'todas correctas'
  );

  const entregadosB = B.resultados.filter((r) => r.entregada);
  const sinTraza = entregadosB.filter((r) => !r.zona || !r.motivo);
  add(
    'La versión nueva informa zona/score/motivo en cada noticia',
    entregadosB.length > 0 && sinTraza.length === 0,
    sinTraza.length ? `faltan en ${sinTraza.length} temas` : `${entregadosB.length} de ${entregadosB.length}`
  );

  const conCorral = B.resultados.filter((r) => r.tipo === 'libre' && r.entregada && !r.rescate && r.corral && r.articulo);
  const violan = conCorral.filter((r) => norm(r.articulo.categoria) !== norm(r.corral));
  add(
    'Temas libres: se respeta el corral de categoría inferido',
    violan.length === 0,
    violan.length
      ? `violan el corral: ${violan.slice(0, 3).map((r) => r.tema).join(', ')}`
      : `${conCorral.length} temas con corral, 0 violaciones`
  );

  const dl = B.meta?.digestLog;
  add(
    'DigestTestLog guarda los campos nuevos (zona, score, motivo, corral…)',
    !!(dl && dl.validaOk && dl.guardaCamposNuevos),
    dl ? (dl.error ? `error: ${dl.error}` : `valida=${dl.validaOk}, guarda campos=${dl.guardaCamposNuevos}`) : 'sin datos'
  );

  const erroresA = A.resultados.filter((r) => r.error).length;
  const erroresB = B.resultados.filter((r) => r.error).length;
  add('Sin errores de ejecución', erroresA === 0 && erroresB === 0, `antes ${erroresA}, después ${erroresB}`);

  const dA = A.meta?.dbArticulos48h;
  const dB = B.meta?.dbArticulos48h;
  if (typeof dA === 'number' && typeof dB === 'number' && Math.max(dA, dB) > 0) {
    const deriva = Math.abs(dA - dB) / Math.max(dA, dB);
    add(
      'Mismos datos en las dos corridas (deriva de la base < 3 %)',
      deriva < 0.03,
      `notas de las últimas 48 h: antes ${dA}, después ${dB} (${redondear(100 * deriva)} %)`,
      'aviso'
    );
  }

  if (extra.faltantesOficiales && extra.faltantesOficiales.length) {
    add(
      'La lista de temas oficiales coincide con el código',
      false,
      `no aparecen en pickBestArticlePerTopic.js: ${extra.faltantesOficiales.join(', ')}`,
      'aviso'
    );
  }

  return items;
}

// ---------------------------------------------------------------- veredicto

/**
 * Criterio sugerido (no es ley): mejora si los temas libres no empeoran en nada importante
 * y los oficiales tampoco. Los números van siempre al lado para que juzgues vos.
 */
function veredicto(resA, resB, filasLibres, filasOficiales) {
  const checks = [];
  const add = (nombre, estado, detalle) => checks.push({ nombre, estado, detalle });
  const tol = (n) => Math.max(1, Math.round(n * 0.02)); // tolerancia: 2 % de los temas, mínimo 1

  const L = { a: resA.libres, b: resB.libres };
  const O = { a: resA.oficiales, b: resB.oficiales };
  const f = (x) => (x === null || x === undefined ? 'n/d' : redondear(x));
  const conRescate = (x) => `${x.cuenta.rescate} (${f(x.pct.rescate)} %)`;

  // menos es mejor / más es mejor / "no empeora" con tolerancia opcional
  const menos = (a, b) => (b < a ? 'ok' : b === a ? 'igual' : 'mal');
  const mas = (a, b) => (b > a ? 'ok' : b === a ? 'igual' : 'mal');
  const noEmpeora = (a, b, tolerancia = 0) => (b < a ? 'ok' : b === a ? 'igual' : b <= a + tolerancia ? 'aviso' : 'mal');

  if (L.b.n > 0) {
    add('Libres: menos rescates', menos(L.a.cuenta.rescate, L.b.cuenta.rescate),
      `antes ${conRescate(L.a)} → después ${conRescate(L.b)}`);
    add('Libres: más noticias realmente del tema', mas(L.a.cuenta.tema_si, L.b.cuenta.tema_si),
      `antes ${L.a.cuenta.tema_si} (${f(L.a.pct.tema_si)} %) → después ${L.b.cuenta.tema_si} (${f(L.b.pct.tema_si)} %)`);
    add('Libres: sin más fallas silenciosas (fuera de tema presentado como del tema)',
      noEmpeora(L.a.cuenta.tema_no, L.b.cuenta.tema_no, tol(L.b.n)),
      `antes ${L.a.cuenta.tema_no} → después ${L.b.cuenta.tema_no}`);

    const reg = filasLibres.filter((x) => x.estado === 'regresion').length;
    const mej = filasLibres.filter((x) => x.estado === 'mejora').length;
    add('Libres: mejoras ≥ regresiones', mas(reg, mej), `${mej} temas mejoran, ${reg} empeoran`);

    // Frescura "pareada": solo temas donde AMBAS versiones entregaron una noticia en tema, así el cambio
    // se debe al peso de la frescura y no a que una versión entregue más temas que la otra.
    const deltas = filasLibres.map((x) => x.deltaEdad).filter((d) => typeof d === 'number');
    if (deltas.length) {
      const mediana = percentil(deltas, 50);
      const masFrescas = deltas.filter((d) => d < 0).length;
      const masViejas = deltas.filter((d) => d > 0).length;
      add('Frescura: en los mismos temas, la noticia entregada es igual o más reciente',
        mediana < 0 ? 'ok' : mediana === 0 ? 'igual' : 'aviso',
        `${deltas.length} temas con noticia en las dos versiones: ${masFrescas} más frescas, ${masViejas} más viejas ` +
        `(cambio mediano ${redondear(mediana)} h)`);
    }

    const tA = L.a.tiempo.p95;
    const tB = L.b.tiempo.p95;
    if (tA && tB) {
      // Solo alarma si es MUY distinto: unos pocos ms de diferencia son ruido.
      const lento = tB > tA * 1.5 && tB - tA > 250;
      add('Velocidad: p95 por tema no se degrada más de 50 %', lento ? 'aviso' : 'igual', `antes ${tA} ms → después ${tB} ms`);
    }
  }

  if (O.b.n > 0) {
    const sinNoticiaOf = (x) => x.cuenta.rescate + x.cuenta.sin_noticia;
    add('Oficiales: no hay más rescates ni temas sin noticia', menos(sinNoticiaOf(O.a), sinNoticiaOf(O.b)),
      `antes ${sinNoticiaOf(O.a)} → después ${sinNoticiaOf(O.b)}`);
    add('Oficiales: no baja la coincidencia con el subtema', mas(O.a.cuenta.tema_si, O.b.cuenta.tema_si),
      `antes ${O.a.cuenta.tema_si} → después ${O.b.cuenta.tema_si} de ${O.b.n}`);
  }

  const malas = checks.filter((c) => c.estado === 'mal').length;
  const avisos = checks.filter((c) => c.estado === 'aviso').length;
  const oks = checks.filter((c) => c.estado === 'ok').length;
  const global = malas ? 'EMPEORA' : avisos ? 'REVISAR' : oks ? 'MEJORA' : 'SIN CAMBIOS';
  return { checks, global };
}

module.exports = {
  MAX_EDAD_HORAS,
  RANGO,
  ETIQUETAS,
  palabrasTema,
  mencionaTema,
  percentil,
  relevanciaDe,
  particion,
  resumir,
  soloEnComun,
  compararVersiones,
  contarEstados,
  chequeosCordura,
  veredicto,
};
