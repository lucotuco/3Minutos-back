'use strict';

/**
 * concurrencyGate.js
 *
 * Un tope de tareas simultáneas. `createGate(max)` devuelve `run(tarea)`: ejecuta la tarea enseguida si hay lugar, y si
 * no, la deja esperando su turno (en el orden en que llegaron). El lugar vuelve cuando la tarea termina, bien o mal;
 * al volver pasa directo al que espera, así que nunca hay más de `max` tareas corriendo, ni siquiera si llegan nuevas
 * justo cuando otra termina.
 */
function createGate(max) {
  const limit = Math.max(1, Math.floor(Number(max)) || 1);
  let active = 0;
  const waiting = [];

  return async function run(task) {
    if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next(); // el lugar pasa directo al que espera: `active` no cambia
      else active--;
    }
  };
}

module.exports = { createGate };
