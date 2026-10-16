'use strict';

/**
 * Arma y guarda el reporte del test de estrés: JSON completo, CSV de hallazgos, CSV de tópicos
 * (escenario A), HTML y un resumen de consola. construirReporte() y los textos son puros.
 */

const fs = require('fs');
const path = require('path');
const { conteo } = require('./estadisticas');
const { ordenar } = require('./hallazgo');
const { SEVERIDADES } = require('./config');

const VERSION_ESQUEMA = 1;

function veredicto(porSeveridad) {
  const n = (s) => porSeveridad[s] || 0;
  if (n('CRITICA')) return { nivel: 'ROJO', texto: `Hay ${n('CRITICA')} falla(s) CRÍTICA(S): una garantía básica del sistema se rompió.` };
  if (n('ALTA')) return { nivel: 'NARANJA', texto: `No hay fallas críticas, pero sí ${n('ALTA')} problema(s) de severidad ALTA.` };
  if (n('MEDIA')) return { nivel: 'AMARILLO', texto: `Sin problemas altos; ${n('MEDIA')} hallazgo(s) de severidad MEDIA para revisar.` };
  return { nivel: 'VERDE', texto: 'No se encontraron problemas de severidad media o superior en lo que se probó.' };
}

/** Une todo en un objeto serializable. `meta.host` no se incluye en los archivos. */
function construirReporte({ meta, plan, escenarios, estatico = [], globales = [], contadores = null, topErrores = [], erroresInternos = [] }) {
  const { host: _host, ...metaPublica } = meta || {};
  const internos = erroresInternos.map((e) => ({
    id: 'X-ERROR-DEL-TEST', severidad: 'ALTA', escenario: e.escenario,
    titulo: `Error interno del test en el escenario ${e.escenario}: ${e.mensaje}`,
    detalle: 'Esto es un bug del script de estrés, no del sistema probado. Avisar con el mensaje completo.',
    evidencia: [], sugerencia: '',
  }));
  const hallazgos = ordenar([...estatico, ...globales, ...internos, ...escenarios.flatMap((e) => e.hallazgos || [])]);
  const porSeveridad = conteo(hallazgos.map((h) => h.severidad));
  return {
    version: VERSION_ESQUEMA, meta: metaPublica, plan, contadores, topErrores, escenarios, hallazgos, porSeveridad,
    veredicto: veredicto(porSeveridad),
  };
}

// ---------------------------------------------------------------- CSV
function celdaCsv(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // evita que Excel lo interprete como fórmula
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const filaCsv = (arr) => arr.map(celdaCsv).join(',');

function csvHallazgos(rep) {
  const filas = [filaCsv(['severidad', 'escenario', 'id', 'titulo', 'detalle', 'evidencia', 'sugerencia'])];
  for (const h of rep.hallazgos) {
    filas.push(filaCsv([h.severidad, h.escenario, h.id, h.titulo, h.detalle, (h.evidencia || []).join(' | '), h.sugerencia]));
  }
  return `﻿${filas.join('\n')}\n`;
}

function csvTopicosA(rep) {
  const A = rep.escenarios.find((e) => e.id === 'A');
  const filas = [filaCsv(['tema', 'tipo', 'nivel', 'categoria', 'llamadas', 'entregas', 'notas_distintas', 'pct_nota_mas_frecuente',
    'clase_mas_frecuente', 'rescates', 'vacios', 'errores', 'errores_busqueda', 'cambios_de_nota', 'p50_ms', 'p95_ms', 'violaciones', 'nota_mas_frecuente'])];
  for (const t of (A?.porTema || [])) {
    filas.push(filaCsv([t.tema, t.tipo, t.nivel, t.categoria, t.n, t.entregas, t.distintos, Math.round(t.pctModal), t.claseModal,
      t.rescates, t.vacios, t.errores, t.erroresBusqueda, t.transiciones, t.ms.p50, t.ms.p95, t.violaciones, t.modalTitulo]));
  }
  return `﻿${filas.join('\n')}\n`;
}

// ---------------------------------------------------------------- consola
const ICONO = { CRITICA: '🔴', ALTA: '🟠', MEDIA: '🟡', BAJA: '🔵', INFO: '⚪' };

function textoConsola(rep, archivos = []) {
  const L = [];
  L.push('', '════════════════════════════════════════════════════════════', ` ESTRÉS 3Minutos · nivel ${rep.meta.nivel} · ${rep.meta.duracionMin} min${rep.meta.parcial ? ' · PARCIAL' : ''}`, '════════════════════════════════════════════════════════════');
  L.push(` Veredicto: ${rep.veredicto.nivel} — ${rep.veredicto.texto}`);
  L.push(` Hallazgos: ${SEVERIDADES.map((s) => `${ICONO[s]} ${rep.porSeveridad[s] || 0} ${s}`).join('  ')}`);
  if (rep.meta.parcial) L.push(` ⚠ Corrida interrumpida: ${rep.meta.motivoParada || 'sin motivo'}. Los números son parciales.`);
  const c = rep.contadores;
  if (c) {
    L.push(` OpenAI: ${c.openai.chat.llamadas} chat + ${c.openai.embeddings.llamadas} embeddings (errores 429: ${c.openai.chat.err429 + c.openai.embeddings.err429}) · ` +
      `Mongo: ${c.mongo.comandos} comandos, ${c.mongo.fallos} fallos, ${c.mongo.escrituras} escrituras`);
  }
  const importantes = rep.hallazgos.filter((h) => ['CRITICA', 'ALTA', 'MEDIA'].includes(h.severidad));
  L.push('', ' Lo más importante:');
  if (!importantes.length) L.push('   (nada de severidad media o mayor)');
  for (const h of importantes.slice(0, 15)) {
    L.push(`  ${ICONO[h.severidad]} [${h.escenario}] ${h.titulo}`);
    for (const e of (h.evidencia || []).slice(0, 2)) L.push(`        · ${e}`);
  }
  if (importantes.length > 15) L.push(`   … y ${importantes.length - 15} más en el reporte.`);
  if (archivos.length) L.push('', ' Archivos:', ...archivos.map((a) => `   ${a}`));
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------- disco
function guardarReporte(rep, dir, htmlFn) {
  fs.mkdirSync(dir, { recursive: true });
  const archivos = {
    json: path.join(dir, 'estres.json'),
    hallazgos: path.join(dir, 'hallazgos.csv'),
    topicos: path.join(dir, 'topicos_A.csv'),
    html: path.join(dir, 'reporte.html'),
  };
  fs.writeFileSync(archivos.json, JSON.stringify(rep, null, 2));
  fs.writeFileSync(archivos.hallazgos, csvHallazgos(rep));
  fs.writeFileSync(archivos.topicos, csvTopicosA(rep));
  fs.writeFileSync(archivos.html, htmlFn(rep));
  return archivos;
}

module.exports = { construirReporte, veredicto, celdaCsv, csvHallazgos, csvTopicosA, textoConsola, guardarReporte, ICONO };
