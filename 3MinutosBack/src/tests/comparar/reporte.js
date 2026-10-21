'use strict';

/**
 * Genera el reporte (HTML + CSV + texto de consola) a partir de dos corridas.
 */

const { ETIQUETAS, relevanciaDe, particion } = require('./metricas');

// ---------------------------------------------------------------- helpers

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function num(x, d = 1) {
  if (x === null || x === undefined || Number.isNaN(x)) return '–';
  return Number(x).toLocaleString('es-AR', { maximumFractionDigits: d, minimumFractionDigits: 0 });
}

const urlSegura = (u) => /^https?:\/\//i.test(String(u || '')); // solo links http(s) en el reporte

const cant = (n, pct) => `${n} <small>(${num(pct, 0)} %)</small>`;

function delta(a, b, buenoSiSube, d = 0) {
  if (a === null || b === null || a === undefined || b === undefined) return '';
  const dif = b - a;
  if (Math.abs(dif) < 1e-9) return '<span class="d0">=</span>';
  const bueno = buenoSiSube ? dif > 0 : dif < 0;
  const signo = dif > 0 ? '+' : '−';
  return `<span class="${bueno ? 'dok' : 'dmal'}">${signo}${num(Math.abs(dif), d)}</span>`;
}

const PARTICION_CLASE = {
  tema_si: 'p-si', tema_parcial: 'p-parcial', rescate: 'p-rescate', sin_noticia: 'p-nada', tema_no: 'p-no',
};

function etiquetaParticion(p) {
  return `<span class="badge ${PARTICION_CLASE[p]}">${esc(ETIQUETAS[p])}</span>`;
}

function celdaVersion(r, mostrarDetalleNuevo) {
  if (!r) return '–';
  const p = particion(r);
  const a = r.articulo;
  const partes = [etiquetaParticion(p)];
  if (r.zona) partes.push(`<span class="zona">${esc(r.zona)}${r.scoreBusqueda != null ? ` ${num(r.scoreBusqueda, 2)}` : ''}</span>`);

  if (!a) {
    return `${partes.join(' ')}<div class="sub">${esc(r.error ? `error: ${r.error}` : r.motivo || 'sin resultado')}</div>`;
  }

  const sub = [];
  if (a.fuente) sub.push(esc(a.fuente));
  if (a.categoria) sub.push(esc(a.categoria));
  if (a.subtema && r.tipo === 'oficial') sub.push(`subtema: ${esc(a.subtema)}`);
  if (a.edadHoras != null) sub.push(`${num(a.edadHoras)} h`);
  if (a.importancia != null) sub.push(`imp. ${num(a.importancia, 0)}${r.nivelNota ? ` (${esc(r.nivelNota)})` : ''}`);
  const rel = relevanciaDe(r);
  if (rel) sub.push(`${r.tipo === 'libre' && r.juez ? 'juez' : 'relev.'}: ${rel}`);
  if (mostrarDetalleNuevo) {
    if (r.candidatosEvaluados) sub.push(`candidato #${r.candidatosEvaluados}`);
    if (r.corral) sub.push(`corral: ${esc(r.corral)}`);
  }

  const titulo = urlSegura(a.url) ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.titulo)}</a>` : esc(a.titulo);
  return `${partes.join(' ')}<div class="titulo">${titulo}</div><div class="sub">${sub.join(' · ')}</div>`;
}

function bloqueLogs(fila) {
  const recortar = (logs) => (logs || []).slice(0, 40).map((l) => (l.length > 240 ? `${l.slice(0, 240)}…` : l)).join('\n');
  const la = recortar(fila.antes.logs);
  const lb = recortar(fila.despues.logs);
  if (!la && !lb) return '';
  return `<details class="logs"><summary>logs</summary><div class="dos"><div><b>antes</b><pre>${esc(la)}</pre></div><div><b>después</b><pre>${esc(lb)}</pre></div></div></details>`;
}

function tablaFilas(filas, { conLogs = false } = {}) {
  if (!filas.length) return '<p class="vacio">Ninguno.</p>';
  const cuerpo = filas.map((f) => `
    <tr>
      <td class="tema">${esc(f.tema)}${f.usuarios ? `<div class="sub">${f.usuarios} usuarios</div>` : ''}${f.nivel === 'categoria' ? '<div class="sub">categoría</div>' : ''}</td>
      <td>${celdaVersion(f.antes, false)}</td>
      <td>${celdaVersion(f.despues, true)}${f.deltaEdad != null && f.deltaEdad !== 0 ? `<div class="sub">${f.deltaEdad < 0 ? 'más fresca' : 'más vieja'} (${num(Math.abs(f.deltaEdad))} h)</div>` : ''}</td>
    </tr>
    ${conLogs ? `<tr class="fila-logs"><td></td><td colspan="2">${bloqueLogs(f)}</td></tr>` : ''}`).join('');
  return `<table class="filas"><thead><tr><th>Tema</th><th>Antes</th><th>Después</th></tr></thead><tbody>${cuerpo}</tbody></table>`;
}

// ---------------------------------------------------------------- tablas de resumen

function tablaResumen(titulo, A, B, esLibre) {
  const filas = [];
  const fila = (nombre, a, b, buenoSiSube, formato = 'n') => {
    const f = (x) => (formato === 'c' ? x : num(x, formato === 'h' ? 1 : 0));
    filas.push(`<tr><td>${nombre}</td><td>${f(a)}</td><td>${f(b)}</td><td>${typeof a === 'number' && typeof b === 'number' ? delta(a, b, buenoSiSube, formato === 'h' ? 1 : 0) : ''}</td></tr>`);
  };
  const cuentas = (k, nombre, bueno) => {
    filas.push(`<tr><td>${nombre}</td><td>${cant(A.cuenta[k], A.pct[k])}</td><td>${cant(B.cuenta[k], B.pct[k])}</td><td>${delta(A.cuenta[k], B.cuenta[k], bueno)}</td></tr>`);
  };

  fila('Temas probados', A.n, B.n, true);
  cuentas('tema_si', esLibre ? 'En tema' : 'En tema (subtema correcto)', true);
  cuentas('tema_parcial', esLibre ? 'Parcial (lo menciona)' : 'Categoría correcta, otro subtema', false);
  cuentas('rescate', 'Rescate («noticia sugerida»)', false);
  cuentas('sin_noticia', 'Sin noticia', false);
  cuentas('tema_no', 'Fuera de tema, sin aviso', false);
  filas.push('<tr class="sep"><td colspan="4">Frescura de la noticia entregada (en tema)</td></tr>');
  fila('Edad mediana (h)', A.edad.mediana, B.edad.mediana, false, 'h');
  fila('Edad p90 (h)', A.edad.p90, B.edad.p90, false, 'h');
  fila('Hasta 6 h (%)', A.edad.pctHasta6, B.edad.pctHasta6, true, 'h');
  fila('Hasta 12 h (%)', A.edad.pctHasta12, B.edad.pctHasta12, true, 'h');
  fila('Hasta 24 h (%)', A.edad.pctHasta24, B.edad.pctHasta24, true, 'h');
  fila('Más de 24 h (%)', A.edad.pctMasDe24, B.edad.pctMasDe24, false, 'h');
  fila('La más vieja de todas (h)', A.edad.maxTodas, B.edad.maxTodas, false, 'h');
  if (A.sustancia?.n || B.sustancia?.n) {
    filas.push('<tr class="sep"><td colspan="4">Sustancia de la noticia entregada (en tema)</td></tr>');
    fila('Importancia mediana', A.sustancia?.mediana ?? null, B.sustancia?.mediana ?? null, true, 'h');
    fila('Buenas, de importancia 50 o más (%)', A.sustancia?.pctBuenas ?? null, B.sustancia?.pctBuenas ?? null, true, 'h');
    fila('Por debajo del piso de 40 (%)', A.sustancia?.pctBajoElPiso ?? null, B.sustancia?.pctBajoElPiso ?? null, false, 'h');
  }
  filas.push('<tr class="sep"><td colspan="4">Cómo se decidió</td></tr>');
  fila('Zona ETIQUETA (oficiales)', A.zonas.ETIQUETA, B.zonas.ETIQUETA, true);
  fila('Zona VERDE', A.zonas.VERDE, B.zonas.VERDE, true);
  fila('Zona AMARILLA', A.zonas.AMARILLA, B.zonas.AMARILLA, true);
  fila('Zona RESCATE', A.zonas.RESCATE, B.zonas.RESCATE, false);
  filas.push(`<tr><td>Candidato elegido (solo versión nueva)</td><td>–</td><td>#1: ${B.candidato['1']} · #2: ${B.candidato['2']} · #3 o más: ${B.candidato['3+']}</td><td></td></tr>`);
  filas.push('<tr class="sep"><td colspan="4">Velocidad por tema</td></tr>');
  fila('p50 (ms)', A.tiempo.p50, B.tiempo.p50, false);
  fila('p95 (ms)', A.tiempo.p95, B.tiempo.p95, false);

  return `<h3>${esc(titulo)}</h3><table class="resumen"><thead><tr><th></th><th>Antes</th><th>Después</th><th>Δ</th></tr></thead><tbody>${filas.join('')}</tbody></table>`;
}

// ---------------------------------------------------------------- HTML

const CSS = `
:root{--bg:#fafaf8;--fg:#1d1d1b;--mut:#6b6b66;--card:#fff;--bd:#e4e2dc;--ok:#1a7f4b;--mal:#b3261e;--av:#a15c00;--azul:#1d5fb3;--okbg:#e3f4ea;--malbg:#fbe5e3;--avbg:#fdf0d8;--azbg:#e2edfb;--grbg:#eceae4}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#eceae4;--mut:#9a9890;--card:#1f1f1c;--bd:#33332e;--ok:#5ccb92;--mal:#ff8a80;--av:#f0b35a;--azul:#7fb2ff;--okbg:#17321f;--malbg:#3a1c1a;--avbg:#3a2d12;--azbg:#15263d;--grbg:#2a2a26}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 16px 64px}h1{font-size:26px;margin:0 0 4px}h2{font-size:20px;margin:36px 0 10px;padding-top:8px;border-top:1px solid var(--bd)}h3{font-size:16px;margin:20px 0 8px}
.meta{color:var(--mut);font-size:13px}.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:14px 16px;margin:12px 0}
.veredicto{display:flex;gap:14px;align-items:center;flex-wrap:wrap}.global{font-size:22px;font-weight:700;padding:6px 14px;border-radius:8px}
.g-MEJORA{background:var(--okbg);color:var(--ok)}.g-EMPEORA{background:var(--malbg);color:var(--mal)}.g-REVISAR{background:var(--avbg);color:var(--av)}.g-SIN{background:var(--grbg)}
ul.checks{list-style:none;padding:0;margin:8px 0 0}ul.checks li{padding:4px 0;border-bottom:1px dashed var(--bd)}ul.checks li:last-child{border:0}
.e-ok::before{content:"✅ "}.e-igual::before{content:"➖ "}.e-aviso::before{content:"⚠️ "}.e-mal::before{content:"❌ "}.c-ok::before{content:"✅ "}.c-error::before{content:"❌ "}.c-aviso::before{content:"⚠️ "}
li small,.sub{color:var(--mut);font-size:12.5px}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--bd);border-radius:8px;overflow:hidden}th,td{padding:8px 10px;border-bottom:1px solid var(--bd);text-align:left;vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);background:var(--bg)}.resumen td:nth-child(n+2),.resumen th:nth-child(n+2){text-align:right;white-space:nowrap}.resumen{max-width:760px}
tr.sep td{background:var(--bg);font-size:12px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
.dok{color:var(--ok);font-weight:600}.dmal{color:var(--mal);font-weight:600}.d0{color:var(--mut)}
.badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;font-weight:600}.p-si{background:var(--okbg);color:var(--ok)}.p-parcial{background:var(--avbg);color:var(--av)}.p-rescate{background:var(--azbg);color:var(--azul)}.p-nada{background:var(--grbg);color:var(--mut)}.p-no{background:var(--malbg);color:var(--mal)}
.zona{font-size:12px;color:var(--mut);margin-left:4px}.titulo{margin:3px 0 1px}.titulo a{color:inherit}.tema{font-weight:600;width:16%}
table.filas td:nth-child(2),table.filas td:nth-child(3){width:42%}tr.fila-logs td{border-bottom:1px solid var(--bd);padding-top:0}
details.logs summary{cursor:pointer;color:var(--mut);font-size:12.5px}.dos{display:grid;grid-template-columns:1fr 1fr;gap:12px}pre{white-space:pre-wrap;word-break:break-word;font-size:11.5px;background:var(--bg);padding:8px;border-radius:6px;margin:4px 0}
details.grupo>summary{cursor:pointer;font-weight:600;margin:14px 0 6px}.vacio{color:var(--mut)}.compacto{color:var(--mut);font-size:13px}
@media (max-width:760px){.dos{grid-template-columns:1fr}table.filas td:nth-child(2),table.filas td:nth-child(3){width:auto}}
`;

function seccionGrupos(titulo, filas) {
  const g = (estado, nombre, abierto) => {
    const lista = filas.filter((f) => f.estado === estado);
    if (estado === 'igual') {
      return `<details class="grupo"><summary>${nombre} (${lista.length})</summary><p class="compacto">${lista.map((f) => esc(f.tema)).join(' · ') || 'Ninguno.'}</p></details>`;
    }
    const ordenadas = [...lista].sort((x, y) => Math.abs(y.deltaRango) - Math.abs(x.deltaRango) || (y.usuarios || 0) - (x.usuarios || 0));
    return `<details class="grupo" ${abierto ? 'open' : ''}><summary>${nombre} (${lista.length})</summary>${tablaFilas(ordenadas, { conLogs: estado !== 'cambia' })}</details>`;
  };
  return `<h3>${esc(titulo)}</h3>${g('mejora', '🟢 Mejoran', true)}${g('regresion', '🔴 Empeoran', true)}${g('cambia', '🔄 Misma calidad, otra noticia', false)}${g('igual', '⚪ Sin cambios', false)}`;
}

function htmlReporte({ A, B, resA, resB, filas, cordura, veredicto, temasInfo }) {
  const libres = filas.filter((f) => f.tipo === 'libre');
  const oficiales = filas.filter((f) => f.tipo === 'oficial');
  const claseGlobal = veredicto.global === 'SIN CAMBIOS' ? 'SIN' : veredicto.global;

  const fuenteRel = resB.libres.relevanciaConJuez;
  const notaRel = fuenteRel === null
    ? 'En temas libres no hubo noticias para evaluar.'
    : fuenteRel > 0.5
      ? 'La relevancia de los temas libres la juzgó un modelo (gpt-4o-mini) con el título y el resumen. Es una guía, no una verdad: revisá a mano los temas que cambian.'
      : 'Sin juez IA: la relevancia de los temas libres se estima por mención del tema en el título (SI), en el cuerpo (PARCIAL) o en ninguno (NO).';

  const ref = (V) => {
    const etiqueta = ['antes', 'despues'].includes(V.meta.etiqueta) ? '' : `<b>${esc(V.meta.etiqueta)}</b> · `;
    return `${etiqueta}commit <code>${esc(V.meta.commit || '?')}</code> (${esc(V.meta.rama || '?')})`;
  };

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>3Minutos · comparación antes/después</title><style>${CSS}</style></head><body><main>
<h1>Comparación antes / después</h1>
<p class="meta">Generado ${esc(new Date().toLocaleString('es-AR'))} · antes: ${ref(A)} · después: ${ref(B)} · base: ${esc(B.meta.baseDeDatos || '?')}<br>
Temas oficiales: ${resB.oficiales.n} · temas libres: ${resB.libres.n} (${esc(temasInfo?.origenLibres || '')}${temasInfo?.cobertura ? `, cubren ${num(100 * temasInfo.cobertura, 0)} % de las preferencias libres` : ''})</p>

<div class="card veredicto"><span class="global g-${claseGlobal}">${esc(veredicto.global)}</span>
<div><b>Veredicto sugerido</b><br><small class="sub">Criterio orientativo; los números están al lado para que juzgues vos.</small></div></div>
<div class="card"><ul class="checks">${veredicto.checks.map((c) => `<li class="e-${c.estado}">${esc(c.nombre)} <small>— ${esc(c.detalle)}</small></li>`).join('')}</ul></div>

<h2>Chequeos de cordura</h2>
<div class="card"><ul class="checks">${cordura.map((c) => `<li class="c-${c.ok ? 'ok' : c.nivel}">${esc(c.nombre)} <small>— ${esc(c.detalle)}</small></li>`).join('')}</ul></div>

<h2>Resumen</h2>
<p class="meta">${esc(notaRel)}</p>
${tablaResumen('Temas libres (los más pedidos)', resA.libres, resB.libres, true)}
${tablaResumen('Temas oficiales', resA.oficiales, resB.oficiales, false)}

<h2>Tema por tema</h2>
${seccionGrupos('Temas libres', libres)}
${seccionGrupos('Temas oficiales', oficiales)}

<h2>Todos los temas oficiales</h2>
${tablaFilas(oficiales)}
</main></body></html>`;
}

// ---------------------------------------------------------------- CSV

function csvComparacion(filas) {
  // Un texto que empiece con = + - @ se interpretaría como fórmula al abrirlo en Excel: se neutraliza.
  const col = (v) => {
    let t = String(v ?? '');
    if (/^[=+\-@]/.test(t)) t = `'${t}`;
    return `"${t.replace(/"/g, '""')}"`;
  };
  const cab = [
    'tipo', 'tema', 'usuarios', 'estado',
    'antes_resultado', 'antes_zona', 'antes_score', 'antes_titulo', 'antes_url', 'antes_edad_h', 'antes_juez',
    'despues_resultado', 'despues_zona', 'despues_score', 'despues_candidato', 'despues_corral', 'despues_titulo', 'despues_url', 'despues_edad_h', 'despues_juez',
    'antes_importancia', 'despues_importancia', 'despues_nivel',
  ];
  const lineas = filas.map((f) => [
    f.tipo, f.tema, f.usuarios, f.estado,
    ETIQUETAS[particion(f.antes)], f.antes.zona, f.antes.scoreBusqueda, f.antes.articulo?.titulo, f.antes.articulo?.url, f.antes.articulo?.edadHoras, f.antes.juez,
    ETIQUETAS[particion(f.despues)], f.despues.zona, f.despues.scoreBusqueda, f.despues.candidatosEvaluados, f.despues.corral, f.despues.articulo?.titulo, f.despues.articulo?.url, f.despues.articulo?.edadHoras, f.despues.juez,
    f.antes.articulo?.importancia, f.despues.articulo?.importancia, f.despues.nivelNota,
  ].map(col).join(';'));
  return `﻿${cab.join(';')}\n${lineas.join('\n')}\n`;
}

// ---------------------------------------------------------------- consola

function textoConsola({ resA, resB, filas, cordura, veredicto }) {
  const L = [];
  const f1 = (x) => (x === null || x === undefined ? 'n/d' : String(Math.round(x * 10) / 10));
  const fila = (nombre, a, b) => L.push(`  ${nombre.padEnd(34)} ${String(a).padStart(14)} ${String(b).padStart(14)}`);
  const c = (R, k) => `${R.cuenta[k]} (${Math.round(R.pct[k])} %)`;

  for (const [titulo, clave] of [['TEMAS LIBRES', 'libres'], ['TEMAS OFICIALES', 'oficiales']]) {
    const a = resA[clave];
    const b = resB[clave];
    L.push('', `${titulo} (${b.n})`, `  ${''.padEnd(34)} ${'ANTES'.padStart(14)} ${'DESPUÉS'.padStart(14)}`);
    fila('En tema', c(a, 'tema_si'), c(b, 'tema_si'));
    fila(clave === 'libres' ? 'Parcial (lo menciona)' : 'Otro subtema', c(a, 'tema_parcial'), c(b, 'tema_parcial'));
    fila('Rescate (noticia sugerida)', c(a, 'rescate'), c(b, 'rescate'));
    fila('Sin noticia', c(a, 'sin_noticia'), c(b, 'sin_noticia'));
    fila('Fuera de tema sin aviso', c(a, 'tema_no'), c(b, 'tema_no'));
    fila('Edad mediana (h)', f1(a.edad.mediana), f1(b.edad.mediana));
    fila('Hasta 6 h', `${f1(a.edad.pctHasta6)} %`, `${f1(b.edad.pctHasta6)} %`);
    fila('Hasta 12 h', `${f1(a.edad.pctHasta12)} %`, `${f1(b.edad.pctHasta12)} %`);
    fila('La más vieja (h)', f1(a.edad.maxTodas), f1(b.edad.maxTodas));
    if (a.sustancia?.n || b.sustancia?.n) fila('Buenas (importancia 50+)', `${f1(a.sustancia?.pctBuenas)} %`, `${f1(b.sustancia?.pctBuenas)} %`);
    fila('p95 por tema (ms)', f1(a.tiempo.p95), f1(b.tiempo.p95));
  }

  const cuenta = (tipo, estado) => filas.filter((x) => x.tipo === tipo && x.estado === estado).length;
  L.push('', 'TEMA POR TEMA',
    `  libres:    ${cuenta('libre', 'mejora')} mejoran · ${cuenta('libre', 'regresion')} empeoran · ${cuenta('libre', 'cambia')} cambian igual de bien/mal · ${cuenta('libre', 'igual')} sin cambios`,
    `  oficiales: ${cuenta('oficial', 'mejora')} mejoran · ${cuenta('oficial', 'regresion')} empeoran · ${cuenta('oficial', 'cambia')} cambian igual de bien/mal · ${cuenta('oficial', 'igual')} sin cambios`);

  L.push('', 'CORDURA');
  for (const x of cordura) L.push(`  ${x.ok ? '✅' : x.nivel === 'aviso' ? '⚠️ ' : '❌'} ${x.nombre} — ${x.detalle}`);

  L.push('', `VEREDICTO SUGERIDO: ${veredicto.global}`);
  const icono = { ok: '✅', igual: '➖', aviso: '⚠️ ', mal: '❌' };
  for (const x of veredicto.checks) L.push(`  ${icono[x.estado]} ${x.nombre} — ${x.detalle}`);
  return L.join('\n');
}

module.exports = { htmlReporte, csvComparacion, textoConsola };
