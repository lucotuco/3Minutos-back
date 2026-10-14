'use strict';

/**
 * Un "hallazgo" es un problema detectado, con severidad, evidencia y una pista de qué mirar.
 * Los analizadores (analisis_*.js) solo producen hallazgos; el reporte los ordena y los muestra.
 */

const { SEVERIDADES } = require('./config');

function hallazgo({ id, severidad, escenario, titulo, detalle = '', evidencia = [], sugerencia = '' }) {
  return { id, severidad, escenario, titulo, detalle, evidencia: evidencia.slice(0, 12), sugerencia };
}

const rango = (s) => {
  const i = SEVERIDADES.indexOf(s);
  return i === -1 ? SEVERIDADES.length : i;
};

function ordenar(hallazgos) {
  return [...hallazgos].sort((a, b) => rango(a.severidad) - rango(b.severidad) || String(a.id).localeCompare(String(b.id)));
}

function peorSeveridad(severidades) {
  return severidades.reduce((peor, s) => (rango(s) < rango(peor) ? s : peor), 'INFO');
}

/**
 * Junta las violaciones de invariantes de muchas filas ({ violaciones: [...] }) en un
 * hallazgo por tipo de violación, con conteo y ejemplos.
 */
function hallazgosDeViolaciones(escenario, filas) {
  const porId = new Map();
  for (const f of filas) {
    for (const v of f.violaciones || []) {
      if (!porId.has(v.id)) porId.set(v.id, { severidad: v.severidad, n: 0, ejemplos: [] });
      const g = porId.get(v.id);
      g.n++;
      g.severidad = peorSeveridad([g.severidad, v.severidad]);
      if (g.ejemplos.length < 8) g.ejemplos.push(`"${v.topic}" → ${v.mensaje}`);
    }
  }
  return [...porId].map(([id, g]) => hallazgo({
    id: `${escenario}-${id}`,
    severidad: g.severidad,
    escenario,
    titulo: `Invariante ${id} violada ${g.n} vez/veces`,
    detalle: 'Una garantía básica del sistema no se cumplió en este escenario.',
    evidencia: g.ejemplos,
    sugerencia: 'Ver la definición del invariante en estres/invariantes.js y reproducir con ese tópico.',
  }));
}

module.exports = { hallazgo, ordenar, peorSeveridad, hallazgosDeViolaciones };
