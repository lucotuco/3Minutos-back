'use strict';

/**
 * Plan de la corrida (lo que muestra --dry-run): cuántas llamadas hace cada escenario y una
 * estimación de carga sobre OpenAI y Mongo. Las cantidades salen de config.tamanios(), la misma
 * función que respetan los escenarios. Pura: no conecta a nada.
 */

const { CONTRATO, tamanios, tareasEscalon } = require('./config');

const SEG_POR_BUSQUEDA = 1.5;  // orden de magnitud: embedding + 2 agregaciones en Atlas
const FACTOR_RESCATE = 1.15;   // ~15 % de las búsquedas hacen una segunda (rescate)
const ID_ESCENARIOS = ['A', 'B', 'C', 'D', 'E', 'F'];

function planificar(nivel, { oficiales, libres, usuarios, hostiles, escenarios = ID_ESCENARIOS }) {
  const t = tamanios(nivel, { oficiales, libres, usuarios, hostiles });
  const soakPicks = Math.round((nivel.F.minutos * 60 / SEG_POR_BUSQUEDA) * Math.max(2, nivel.concurrencia));
  const f = { picks: soakPicks, digests: 0, busquedas: soakPicks };
  const todos = { ...t, F: f };

  const rampaSeg = nivel.D.rampa.reduce((acc, c) => acc + (tareasEscalon(nivel, c) * SEG_POR_BUSQUEDA) / c, 0);
  const rampaDigestSeg = usuarios > 0 ? rampaSeg * CONTRATO.topicosPorUsuario : 0;
  const segundos = {
    A: (t.A.busquedas * SEG_POR_BUSQUEDA) / nivel.concurrencia,
    B: (t.B.busquedas * SEG_POR_BUSQUEDA) / nivel.concurrencia,
    C: (t.C.busquedas * SEG_POR_BUSQUEDA) / nivel.concurrencia,
    D: rampaSeg + rampaDigestSeg + nivel.D.mega * SEG_POR_BUSQUEDA + 30,
    E: (t.E.busquedas * SEG_POR_BUSQUEDA) / nivel.concurrencia,
    F: nivel.F.minutos * 60,
  };

  const incluidos = ID_ESCENARIOS.filter((id) => escenarios.includes(id) && (id !== 'F' || nivel.F.minutos > 0));
  const suma = (campo) => incluidos.reduce((acc, id) => acc + (todos[id][campo] || 0), 0);
  const busquedas = suma('busquedas');
  const unicosSoak = Math.round(soakPicks * 0.1);
  return {
    porEscenario: Object.fromEntries(incluidos.map((id) => [id, { ...todos[id], segundosEst: Math.round(segundos[id]) }])),
    totales: {
      picks: suma('picks'),
      digests: suma('digests'),
      busquedas,
      embeddingsEst: Math.round(busquedas * FACTOR_RESCATE),
      agregacionesAtlasEst: Math.round(busquedas * FACTOR_RESCATE * 2),
      expansionesMaxEst: oficiales + libres + hostiles + nivel.D.mega + 5 + (incluidos.includes('F') ? unicosSoak : 0),
      minutosEst: Math.round(incluidos.reduce((acc, id) => acc + segundos[id], 0) / 60),
    },
    limites: { maxOpenAI: nivel.maxOpenAI, maxMinutos: nivel.maxMinutos },
    supuestos: { segundosPorBusqueda: SEG_POR_BUSQUEDA, factorRescate: FACTOR_RESCATE, usuarios },
  };
}

function textoPlan(nivel, plan) {
  const L = [];
  L.push(`Plan · nivel ${nivel.nombre}: ${nivel.descripcion}`);
  L.push('');
  L.push('  escenario  llamadas a pick  digests  búsquedas  tiempo aprox.');
  for (const [id, e] of Object.entries(plan.porEscenario)) {
    L.push(`  ${id}          ${String(e.picks).padStart(10)}  ${String(e.digests ?? 0).padStart(7)}  ${String(e.busquedas).padStart(9)}  ${String(Math.max(1, Math.round(e.segundosEst / 60))).padStart(6)} min`);
  }
  const t = plan.totales;
  L.push('');
  L.push(`  Total: ${t.picks} llamadas a pick + ${t.digests} digests ≈ ${t.busquedas} búsquedas.`);
  L.push(`  OpenAI: ≈ ${t.embeddingsEst} embeddings + hasta ≈ ${t.expansionesMaxEst} expansiones de consulta (chat).`);
  L.push(`  Mongo/Atlas: ≈ ${t.agregacionesAtlasEst} agregaciones ($vectorSearch + $search) + lecturas de usuarios e historial.`);
  L.push(`  Duración estimada ≈ ${t.minutosEst} min (muy aproximado: depende de Atlas y OpenAI; tope duro ${plan.limites.maxMinutos} min).`);
  L.push(`  Tope de llamadas a OpenAI: ${plan.limites.maxOpenAI} (--max-openai). Al llegar, la corrida corta y entrega lo que tenga.`);
  return L.join('\n');
}

module.exports = { planificar, textoPlan, ID_ESCENARIOS, SEG_POR_BUSQUEDA };
