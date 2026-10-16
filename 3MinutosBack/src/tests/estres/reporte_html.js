'use strict';

/** HTML autocontenido del reporte de estrés (sin librerías externas). Todo texto dinámico se escapa. */

const { SEVERIDADES } = require('./config');
const { ICONO } = require('./reporte');

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const num = (x, d = 0) => (x === null || x === undefined || Number.isNaN(x) ? '–' : Number(x).toLocaleString('es-AR', { maximumFractionDigits: d }));
const pct = (x) => (x === null || x === undefined ? '–' : `${num(x * 100)} %`);

function tabla(cols, filas, max = 80) {
  const head = cols.map((c) => `<th>${esc(c.t)}</th>`).join('');
  const body = filas.slice(0, max).map((f) => `<tr>${cols.map((c) => `<td class="${esc(c.clase ? c.clase(f) : '')}">${esc(c.v(f))}</td>`).join('')}</tr>`).join('');
  const mas = filas.length > max ? `<p class="nota">Se muestran ${max} de ${filas.length} filas; el resto está en el JSON.</p>` : '';
  return `<div class="tabla"><table><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${cols.length}">Sin filas.</td></tr>`}</tbody></table></div>${mas}`;
}

const kpi = (etiqueta, valor) => `<div class="kpi"><b>${esc(valor)}</b><span>${esc(etiqueta)}</span></div>`;
const kpis = (...items) => `<div class="kpis">${items.map(([e, v]) => kpi(e, v)).join('')}</div>`;

function hallazgoHtml(h) {
  const ev = (h.evidencia || []).map((e) => `<li>${esc(e)}</li>`).join('');
  return `<details class="h sev-${esc(h.severidad)}"${h.severidad === 'CRITICA' || h.severidad === 'ALTA' ? ' open' : ''}>` +
    `<summary>${ICONO[h.severidad] || ''} <span class="esc">${esc(h.escenario)}</span> ${esc(h.titulo)}</summary>` +
    `${h.detalle ? `<p>${esc(h.detalle)}</p>` : ''}${ev ? `<ul>${ev}</ul>` : ''}${h.sugerencia ? `<p class="sug">→ ${esc(h.sugerencia)}</p>` : ''}</details>`;
}

const seccion = (id, titulo, cuerpo, parcial) =>
  `<section id="${esc(id)}"><h2>${esc(titulo)}${parcial ? ' <small class="parcial">parcial</small>' : ''}</h2>${cuerpo}</section>`;

const porId = (rep, id) => rep.escenarios.find((e) => e.id === id);

function seccionA(e) {
  const r = e.resumen;
  const mirar = e.porTema.filter((t) => t.distintos > 1 || t.rescates || t.vacios || t.errores || t.violaciones)
    .sort((a, b) => b.errores - a.errores || b.transiciones - a.transiciones || b.rescates - a.rescates);
  return kpis(['llamadas', num(r.llamadas)], ['tópicos', num(r.topicos)], ['estables', `${num(r.pctEstables)} %`],
    ['p95', `${num(r.ms.p95)} ms`], ['nota del tema', num(r.clases.tema || 0)], ['rescate', num(r.clases.rescate || 0)], ['vacío', num(r.clases.vacio || 0)]) +
    '<h3>Tópicos con algo para mirar</h3>' + tabla([
      { t: 'tópico', v: (t) => t.tema }, { t: 'tipo', v: (t) => t.tipo }, { t: 'llamadas', v: (t) => t.n },
      { t: 'notas distintas', v: (t) => t.distintos, clase: (t) => (t.distintos > 1 ? 'mal' : '') },
      { t: 'cambios', v: (t) => t.transiciones, clase: (t) => (t.transiciones > 1 ? 'mal' : '') },
      { t: 'clase', v: (t) => t.claseModal }, { t: 'rescates', v: (t) => t.rescates }, { t: 'errores', v: (t) => t.errores, clase: (t) => (t.errores ? 'mal' : '') },
      { t: 'p95 ms', v: (t) => num(t.ms.p95) }, { t: 'nota más frecuente', v: (t) => (t.modalTitulo || '').slice(0, 70) },
    ], mirar);
}

function seccionB(e) {
  const r = e.resumen;
  return kpis(['tópicos con rondas', num(r.temas)], ['mediana de notas propias', num(r.medianaNotasPropias)], ['llegaron a vacío', num(r.temasQueLlegaronAVacio)],
    ['sesiones de 3 tópicos', num(r.sesiones)], ['notas que reaparecen', num(r.reaparecidas)], ['pares casi iguales', num(r.paresCasiDuplicados)],
    ['medidos con embeddings', e.usoEmbeddingsReales ? 'sí' : 'no (títulos)']) +
    tabla([
      { t: 'tópico', v: (t) => t.tema }, { t: 'rondas', v: (t) => t.rondas }, { t: 'con nota propia', v: (t) => t.conTema },
      { t: 'rescates', v: (t) => t.rescates }, { t: '1.ª ronda en rescate', v: (t) => t.primeraRescate ?? '–' },
      { t: '1.ª ronda vacía', v: (t) => t.primeraVacia ?? '–', clase: (t) => (t.primeraVacia ? 'mal' : '') },
      { t: 'repetidas', v: (t) => t.repetidas, clase: (t) => (t.repetidas ? 'mal' : '') },
    ], [...e.porTema].sort((a, b) => a.conTema - b.conTema));
}

function seccionC(e) {
  const r = e.resumen;
  return kpis(['llamadas', num(r.llamadas)], ['tríos', num(r.triplas)], ['con notas casi iguales', num(r.llamadasConCasiDuplicados)],
    ['dependen del orden', num(r.topicosDependientesDelOrden)], ['p95', `${num(r.ms.p95)} ms`]) +
    tabla([
      { t: 'posición', v: (p) => p.posicion }, { t: 'n', v: (p) => p.n },
      { t: '% nota del tema', v: (p) => num(p.tema) }, { t: '% rescate', v: (p) => num(p.rescate) }, { t: '% vacío', v: (p) => num(p.vacio) },
    ], r.porPosicion);
}

function tablaRampa(titulo, filas) {
  if (!filas || !filas.length) return '';
  return `<h3>${esc(titulo)}</h3>` + tabla([
    { t: 'en paralelo', v: (f) => f.c }, { t: 'tareas', v: (f) => f.tareas }, { t: 'req/s', v: (f) => num(f.throughput, 2) },
    { t: 'p50 ms', v: (f) => num(f.p50) }, { t: 'p95 ms', v: (f) => num(f.p95) }, { t: 'p99 ms', v: (f) => num(f.p99) },
    { t: 'errores', v: (f) => pct(f.tasaError), clase: (f) => (f.tasaError >= 0.1 ? 'mal' : '') },
    { t: 'búsquedas tragadas', v: (f) => f.erroresBusqueda, clase: (f) => (f.erroresBusqueda ? 'mal' : '') },
    { t: 'rescates', v: (f) => f.rescates }, { t: 'lag loop ms', v: (f) => num(f.lagP99) }, { t: 'heap MB', v: (f) => num(f.heapMB, 1) },
    { t: '429', v: (f) => (f.openai ? f.openai.chat.err429 + f.openai.embeddings.err429 : '–') },
    { t: 'fallos Mongo', v: (f) => (f.mongo ? f.mongo.fallos + f.mongo.checkOutFallidos : '–') },
    { t: 'estado', v: (f) => (f.quiebra ? `⚠ ${f.motivos.join(', ')}` : 'ok'), clase: (f) => (f.quiebra ? 'mal' : 'bien') },
  ], filas);
}

function seccionD(e) {
  const r = e.resumen;
  const extra = [];
  if (r.lock && r.lock.mismoUsuario) extra.push(`Candado: ${r.lock.mismoUsuario.llamadas} pedidos simultáneos → ${r.lock.mismoUsuario.lecturasUsuario} ejecución(es).`);
  if (r.stampede) extra.push(`Ráfaga sobre un tópico nuevo: ${r.stampede.concurrentes} pedidos → ${r.stampede.llamadasChat} expansión(es) en OpenAI.`);
  if (r.mega) extra.push(`Una llamada con ${r.mega.topics} tópicos: ${num(r.mega.ms)} ms.`);
  return tablaRampa('Rampa de llamadas a pickBestArticlePerTopic', r.rampaPick?.filas) +
    tablaRampa('Rampa de digests completos (usuarios reales)', r.rampaDigest?.filas) +
    (extra.length ? `<ul>${extra.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
}

function seccionE(e) {
  const problemas = e.hostiles.filter((h) => h.lanzo || h.error || h.timeout || h.motivo === 'error_busqueda');
  const grupos = Object.entries(e.resumen.clasesPorGrupo).map(([grupo, c]) => ({ grupo, c: JSON.stringify(c) }));
  return kpis(['entradas hostiles', num(e.resumen.hostiles)], ['con problemas', num(new Set(problemas.map((p) => p.id)).size)],
    ['tópicos con variantes', num(e.resumen.variantes.topicos)], ['clase distinta según escritura', num(e.resumen.variantes.conClaseDistinta)]) +
    '<h3>Resultado por grupo</h3>' + tabla([{ t: 'grupo', v: (g) => g.grupo }, { t: 'clases', v: (g) => g.c }], grupos) +
    '<h3>Entradas que rompieron la búsqueda o la llamada</h3>' + tabla([
      { t: 'id', v: (h) => h.id }, { t: 'grupo', v: (h) => h.grupo }, { t: 'valor', v: (h) => h.valorDesc },
      { t: 'motivo', v: (h) => h.motivo }, { t: 'error', v: (h) => h.error || '' },
    ], problemas);
}

function seccionF(e) {
  return kpis(['tareas', num(e.resumen.tareas)], ['heap MB/min', num(e.resumen.heapMBporMin, 1)], ['RSS MB/min', num(e.resumen.rssMBporMin, 1)],
    ['p95 inicio → final', `${num(e.resumen.p95Inicio)} → ${num(e.resumen.p95Final)} ms`]) +
    tabla([
      { t: 'min', v: (m) => num(m.minuto, 1) }, { t: 'heap MB', v: (m) => num(m.heapMB, 1) }, { t: 'RSS MB', v: (m) => num(m.rssMB, 1) },
      { t: 'lag ms', v: (m) => num(m.lagP99) }, { t: 'tareas', v: (m) => m.tareas }, { t: 'errores', v: (m) => m.errores }, { t: 'p95 ms', v: (m) => num(m.p95) },
    ], e.muestras, 120);
}

const RENDER = { A: seccionA, B: seccionB, C: seccionC, D: seccionD, E: seccionE, F: seccionF };

const CSS = `:root{--bg:#fff;--fg:#1c1e21;--mut:#6b7280;--bd:#e5e7eb;--card:#f8fafc;--mal:#b91c1c;--bien:#15803d}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e5e7eb;--mut:#9ca3af;--bd:#2a2f3a;--card:#171a21;--mal:#f87171;--bien:#4ade80}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:16px}
h1{font-size:1.5rem;margin:.2em 0}h2{margin-top:2em;border-bottom:1px solid var(--bd);padding-bottom:.2em}h3{margin:1.2em 0 .4em}
.ver{padding:12px 16px;border-radius:8px;margin:12px 0;font-weight:600}.ver.ROJO{background:#7f1d1d;color:#fff}.ver.NARANJA{background:#9a3412;color:#fff}.ver.AMARILLO{background:#854d0e;color:#fff}.ver.VERDE{background:#14532d;color:#fff}
.kpis{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}.kpi{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:8px 12px;min-width:110px}.kpi b{display:block;font-size:1.25rem}.kpi span{color:var(--mut);font-size:.8rem}
.tabla{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.85rem}th,td{border:1px solid var(--bd);padding:4px 8px;text-align:left;vertical-align:top}th{background:var(--card)}
td.mal{color:var(--mal);font-weight:600}td.bien{color:var(--bien)}.nota,.sug{color:var(--mut)}small.parcial{color:var(--mal);font-size:.7rem;border:1px solid var(--mal);border-radius:4px;padding:0 4px}
details.h{border:1px solid var(--bd);border-left-width:5px;border-radius:6px;padding:6px 10px;margin:6px 0;background:var(--card);overflow-wrap:anywhere}details.sev-CRITICA{border-left-color:#dc2626}details.sev-ALTA{border-left-color:#ea580c}details.sev-MEDIA{border-left-color:#ca8a04}details.sev-BAJA{border-left-color:#2563eb}details.sev-INFO{border-left-color:#9ca3af}
summary{cursor:pointer}.esc{font-family:monospace;background:var(--bd);border-radius:4px;padding:0 5px;font-size:.8rem}`;

function htmlReporte(rep) {
  const m = rep.meta;
  const secciones = rep.escenarios.filter((e) => RENDER[e.id]).map((e) => seccion(`esc-${e.id}`, `${e.id} · ${e.nombre}`, RENDER[e.id](e), e.parcial));
  const grupos = SEVERIDADES.map((s) => {
    const hs = rep.hallazgos.filter((h) => h.severidad === s);
    return hs.length ? `<h3>${ICONO[s]} ${esc(s)} (${hs.length})</h3>${hs.map(hallazgoHtml).join('')}` : '';
  }).join('');
  const c = rep.contadores;
  const contadores = c ? kpis(['llamadas chat', num(c.openai.chat.llamadas)], ['embeddings', num(c.openai.embeddings.llamadas)],
    ['429 OpenAI', num(c.openai.chat.err429 + c.openai.embeddings.err429)], ['comandos Mongo', num(c.mongo.comandos)],
    ['fallos Mongo', num(c.mongo.fallos)], ['escrituras', num(c.mongo.escrituras)]) : '';
  const errores = rep.topErrores.length ? tabla([{ t: 'error', v: (x) => x.mensaje }, { t: 'veces', v: (x) => x.veces }], rep.topErrores) : '<p class="nota">Sin errores registrados.</p>';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Estrés 3Minutos</title><style>${CSS}</style></head><body>` +
    `<h1>Estrés 3Minutos</h1><p class="nota">Nivel ${esc(m.nivel)} · ${esc(m.iniciadoEn)} · ${esc(m.duracionMin)} min · base ${esc(m.baseConectada)} · commit ${esc(m.commit)} (${esc(m.rama)}) · notas de 48 h: ${esc(m.articulos48h)}</p>` +
    `<div class="ver ${esc(rep.veredicto.nivel)}">${esc(rep.veredicto.nivel)} — ${esc(rep.veredicto.texto)}${m.parcial ? ` (corrida parcial: ${esc(m.motivoParada)})` : ''}</div>` +
    seccion('hallazgos', 'Hallazgos', grupos) + secciones.join('') + seccion('contadores', 'Contadores y errores', contadores + errores) +
    `</body></html>`;
}

module.exports = { htmlReporte, esc };
