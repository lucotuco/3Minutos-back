'use strict';

/**
 * Analizadores PUROS del escenario D (carga y concurrencia) y de los hallazgos globales.
 * Un "paso" de rampa es:
 *   { c, tareas, duracionMs, errores, timeouts, erroresBusqueda, rescates, vacios,
 *     ms: number[], violaciones: [], lagP99, rssMB, heapMB, delta }
 * donde delta = diferencia de contadores (ver instrumentos.diferencia).
 */

const { UMBRALES } = require('./config');
const { resumenLatencias } = require('./estadisticas');
const { hallazgo, hallazgosDeViolaciones } = require('./hallazgo');

const sum = (pasos, f) => pasos.reduce((acc, p) => acc + (f(p) || 0), 0);
const pct = (x) => `${Math.round(x * 100)} %`;

function filaRampa(p, baseP95, timeoutS) {
  const lat = resumenLatencias(p.ms);
  const fallidas = p.errores + p.timeouts + p.erroresBusqueda;
  const tasaError = p.tareas ? fallidas / p.tareas : 0;
  const degradacion = baseP95 && lat.p95 ? lat.p95 / baseP95 : null;
  const motivos = [];
  if (tasaError >= UMBRALES.errorRateQuiebre) motivos.push(`errores ${pct(tasaError)}`);
  if (lat.p95 !== null && lat.p95 >= timeoutS * 1000 * UMBRALES.p95FraccionTimeout) motivos.push(`p95 ${lat.p95} ms`);
  if ((p.lagP99 || 0) >= UMBRALES.lagP99Ms) motivos.push(`event loop ${p.lagP99} ms`);
  if (degradacion !== null && degradacion >= UMBRALES.degradacionP95) motivos.push(`p95 ×${degradacion.toFixed(1)} vs 1 en paralelo`);
  return {
    c: p.c,
    tareas: p.tareas,
    throughput: p.duracionMs ? Math.round((p.tareas / (p.duracionMs / 1000)) * 100) / 100 : null,
    tasaError: Math.round(tasaError * 1000) / 1000,
    errores: p.errores, timeouts: p.timeouts, erroresBusqueda: p.erroresBusqueda,
    rescates: p.rescates, vacios: p.vacios,
    p50: lat.p50, p95: lat.p95, p99: lat.p99, max: lat.max,
    degradacion: degradacion === null ? null : Math.round(degradacion * 10) / 10,
    lagP99: p.lagP99 ?? null, rssMB: p.rssMB ?? null, heapMB: p.heapMB ?? null,
    openai: p.delta?.openai || null, mongo: p.delta?.mongo || null,
    quiebra: motivos.length > 0, motivos,
  };
}

function analizarRampa(pasos, { timeoutS = 60, etiqueta = 'pick' } = {}) {
  const baseP95 = pasos.length ? resumenLatencias(pasos[0].ms).p95 : null;
  const filas = pasos.map((p) => filaRampa(p, baseP95, timeoutS));
  const E = etiqueta.toUpperCase();
  const hallazgos = [];
  const push = (cond, h) => { if (cond) hallazgos.push(hallazgo({ escenario: 'D', ...h })); };

  const quiebre = filas.find((f) => f.quiebra);
  const linea = (f) => `${f.c} en paralelo: ${f.throughput ?? '–'} req/s · p95 ${f.p95 ?? '–'} ms · errores ${pct(f.tasaError)} · rescates ${f.rescates}${f.quiebra ? ` ⚠ ${f.motivos.join(', ')}` : ''}`;
  push(quiebre, {
    id: `D-QUIEBRE-${E}`, severidad: 'ALTA',
    titulo: `La rampa de ${etiqueta} se degrada desde ${quiebre?.c} en paralelo`,
    detalle: `Motivos: ${quiebre?.motivos.join(', ')}.`,
    evidencia: filas.map(linea),
    sugerencia: 'Ver qué se saturó primero: OpenAI (429), el pool de Mongo o el event loop (columnas del reporte).',
  });
  push(!quiebre && filas.length, {
    id: `D-SIN-QUIEBRE-${E}`, severidad: 'INFO',
    titulo: `La rampa de ${etiqueta} no se quebró hasta ${filas[filas.length - 1]?.c} en paralelo`,
    evidencia: filas.map(linea),
  });
  if (etiqueta === 'digest' && filas[0]?.throughput) {
    const porMin = filas[0].throughput * 60;
    push(true, {
      id: 'D-CAPACIDAD-CRON', severidad: 'INFO',
      titulo: `Con 1 digest a la vez (como la cron) salen ≈${Math.round(porMin)} digests por minuto`,
      detalle: `1.000 usuarios en una misma ventana horaria tardarían ≈${Math.round(1000 / porMin)} min. ` +
        'Medido sin la curación de OpenAI (se simula para no escribir), así que en producción es más lento.',
    });
  }

  const tragados = pasos.filter((p) => p.erroresBusqueda > 0);
  push(tragados.length, {
    id: `D-ERRORES-TRAGADOS-${E}`, severidad: 'ALTA',
    titulo: `Bajo carga, ${sum(tragados, (p) => p.erroresBusqueda)} búsqueda(s) fallaron y se convirtieron en "noticia sugerida"`,
    detalle: 'El sistema "responde bien" pero con una nota que no tiene que ver: la carga se ve como un problema de calidad.',
    evidencia: tragados.map((p) => `${p.c} en paralelo: ${p.erroresBusqueda}/${p.tareas}`),
  });

  const e429 = sum(pasos, (p) => (p.delta?.openai?.chat?.err429 || 0) + (p.delta?.openai?.embeddings?.err429 || 0));
  push(e429 > 0, {
    id: `D-OPENAI-429-${E}`, severidad: 'ALTA',
    titulo: `OpenAI devolvió ${e429} error(es) 429 (rate limit)`,
    evidencia: pasos.filter((p) => (p.delta?.openai?.chat?.err429 || 0) + (p.delta?.openai?.embeddings?.err429 || 0) > 0)
      .map((p) => `${p.c} en paralelo: chat ${p.delta.openai.chat.err429}, embeddings ${p.delta.openai.embeddings.err429}`),
    sugerencia: 'Límite de RPM/TPM de la API key; cachear embeddings de consulta y expansiones para bajar llamadas.',
  });
  const eOtros = sum(pasos, (p) => ['chat', 'embeddings'].reduce((a, k) => a + (p.delta?.openai?.[k]?.err5xx || 0) + (p.delta?.openai?.[k]?.errTimeout || 0) + (p.delta?.openai?.[k]?.errOtros || 0), 0));
  push(eOtros > 0, { id: `D-OPENAI-ERRORES-${E}`, severidad: 'MEDIA', titulo: `OpenAI devolvió ${eOtros} error(es) de red/servidor/timeout` });

  const mFallos = sum(pasos, (p) => p.delta?.mongo?.fallos);
  push(mFallos > 0, { id: `D-MONGO-FALLOS-${E}`, severidad: 'ALTA', titulo: `Mongo falló en ${mFallos} comando(s) durante la rampa` });
  const mPool = sum(pasos, (p) => p.delta?.mongo?.checkOutFallidos);
  push(mPool > 0, { id: `D-MONGO-POOL-${E}`, severidad: 'ALTA', titulo: `El pool de conexiones de Mongo rechazó ${mPool} pedido(s) de conexión` });

  const lag = pasos.filter((p) => (p.lagP99 || 0) >= 200);
  push(lag.length && !quiebre, {
    id: `D-LAG-${E}`, severidad: 'MEDIA', titulo: 'El event loop de Node se atrasó más de 200 ms',
    evidencia: lag.map((p) => `${p.c} en paralelo: p99 ${p.lagP99} ms`),
  });

  return { filas, quiebre: quiebre ? quiebre.c : null, hallazgos: [...hallazgos, ...hallazgosDeViolaciones('D', pasos)] };
}

function analizarLock(lock) {
  if (!lock) return [];
  const out = [];
  const push = (cond, h) => { if (cond) out.push(hallazgo({ escenario: 'D', ...h })); };
  const m = lock.mismoUsuario;
  if (m) {
    push(m.lecturasUsuario > 1, {
      id: 'D-LOCK-NO-AGRUPA', severidad: 'ALTA',
      titulo: `${m.llamadas} generaciones simultáneas del mismo usuario hicieron ${m.lecturasUsuario} ejecuciones completas`,
      detalle: 'El candado de buildDigestForUser debería juntar las llamadas simultáneas en una sola.',
    });
    push(m.resueltas > 1 && !m.mismosItems, { id: 'D-LOCK-RESULTADOS-DISTINTOS', severidad: 'ALTA', titulo: 'Las llamadas agrupadas por el candado devolvieron digests distintos' });
    push(m.lecturasUsuario === 1 && m.rechazadas === 0, {
      id: 'D-LOCK-OK', severidad: 'INFO',
      titulo: `El candado agrupó ${m.llamadas} llamadas simultáneas en 1 ejecución`,
    });
  }
  const f = lock.usuarioInexistente;
  if (f) {
    push(f.resueltas > 0, { id: 'D-LOCK-INEXISTENTE-RESUELVE', severidad: 'ALTA', titulo: 'Un usuario inexistente devolvió un digest' });
    push(f.reintento && f.reintento.lecturasDespues <= f.reintento.lecturasAntes, {
      id: 'D-LOCK-NO-LIBERA', severidad: 'CRITICA',
      titulo: 'Después de una generación fallida el candado no se liberó',
      detalle: 'La siguiente llamada devolvió la promesa rechazada anterior en vez de reintentar.',
    });
    push(f.reintento && f.reintento.lecturasDespues > f.reintento.lecturasAntes, {
      id: 'D-LOCK-LIBERA', severidad: 'INFO', titulo: 'El candado se libera correctamente después de un error',
    });
  }
  push(lock.motivoOmitido, { id: 'D-LOCK-OMITIDO', severidad: 'INFO', titulo: `Prueba del candado omitida: ${lock.motivoOmitido}` });
  return out;
}

function analizarStampede(s) {
  if (!s) return [];
  // Solo las expansiones: las preguntas de los jueces con IA también son llamadas de chat, pero no son una ráfaga repetida.
  const expansiones = s.llamadasExpansion ?? s.llamadasChat;
  const mal = expansiones >= 2;
  return [hallazgo({
    escenario: 'D',
    id: mal ? 'D-STAMPEDE-EXPANSION' : 'D-EXPANSION-OK',
    severidad: mal ? 'MEDIA' : 'INFO',
    titulo: mal
      ? `${s.concurrentes} llamadas simultáneas con el mismo tópico nuevo hicieron ${expansiones} expansiones en OpenAI (debería ser 1)`
      : `${s.concurrentes} llamadas simultáneas con el mismo tópico nuevo hicieron ${expansiones} expansión`,
    detalle: mal ? 'La expansión no comparte la llamada en curso: todos los pedidos simultáneos del mismo tópico nuevo pagan la expansión (topicExpansion.js debería compartir la promesa en vuelo).' : '',
    evidencia: [`embeddings: ${s.llamadasEmbedding} · preguntas a jueces: ${s.llamadasJuez ?? 'n/d'} · errores: ${s.errores} · ${s.ms} ms`],
    sugerencia: mal ? 'Guardar la promesa (no el resultado) en el Map de expansiones.' : '',
  })];
}

function analizarMega(m) {
  if (!m) return [];
  const out = hallazgosDeViolaciones('D-MEGA', [{ violaciones: m.violaciones || [] }]).map((h) => ({ ...h, escenario: 'D' }));
  const push = (cond, h) => { if (cond) out.push(hallazgo({ escenario: 'D', ...h })); };
  push(m.error || m.timeout, { id: 'D-MEGA-FALLA', severidad: 'ALTA', titulo: `Una llamada con ${m.topics} tópicos falló: ${m.error}` });
  push(m.erroresBusqueda > 0, { id: 'D-MEGA-ERRORES-TRAGADOS', severidad: 'MEDIA', titulo: `En la llamada de ${m.topics} tópicos, ${m.erroresBusqueda} búsquedas fallaron y cayeron a rescate` });
  push(!m.error, {
    id: 'D-MEGA-SECUENCIAL', severidad: 'INFO',
    titulo: `${m.topics} tópicos en una sola llamada: ${m.ms} ms (≈${Math.round(m.ms / Math.max(1, m.topics))} ms por tópico)`,
    detalle: 'La expansión y la búsqueda de los tópicos libres salen juntas (con un tope de 6 a la vez); la elección de la nota es tópico por tópico, en orden.',
    evidencia: [`expansiones en OpenAI: ${m.llamadasExpansion ?? m.llamadasChat} · preguntas a jueces: ${m.llamadasJuez ?? 'n/d'} · rescates: ${m.rescates}`],
  });
  return out;
}

function analizarCarga({ rampaPick = null, rampaDigest = null, lock = null, stampede = null, mega = null } = {}, { timeoutS = 60 } = {}) {
  const rp = rampaPick && rampaPick.length ? analizarRampa(rampaPick, { timeoutS, etiqueta: 'pick' }) : null;
  const rd = rampaDigest && rampaDigest.length ? analizarRampa(rampaDigest, { timeoutS, etiqueta: 'digest' }) : null;
  return {
    resumen: { rampaPick: rp ? { filas: rp.filas, quiebre: rp.quiebre } : null, rampaDigest: rd ? { filas: rd.filas, quiebre: rd.quiebre } : null, lock, stampede, mega },
    hallazgos: [...(rp?.hallazgos || []), ...(rd?.hallazgos || []), ...analizarLock(lock), ...analizarStampede(stampede), ...analizarMega(mega)],
  };
}

/** Hallazgos que salen de los contadores de toda la corrida. */
function hallazgosGlobales({ contadores = null, parcial = false, motivoParada = null } = {}) {
  const out = [];
  const push = (cond, h) => { if (cond) out.push(hallazgo({ escenario: 'G', ...h })); };
  const emb = contadores?.openai?.embeddings;
  push((contadores?.mongo?.escrituras || 0) > 0, {
    id: 'G-ESCRITURAS', severidad: 'CRITICA',
    titulo: `El test emitió ${contadores?.mongo?.escrituras} comando(s) de escritura contra Mongo`,
    detalle: 'El estrés debe ser de solo lectura. Revisar qué código escribió antes de volver a correrlo.' +
      (contadores?.mongo?.ejemplosEscritura ? ` Comandos vistos: ${contadores.mongo.ejemplosEscritura}.` : ''),
  });
  push(emb && emb.llamadas >= 20 && emb.unicos > 0 && emb.llamadas / emb.unicos >= 1.5, {
    id: 'G-EMBEDDINGS-REPETIDOS', severidad: 'BAJA',
    titulo: `Se pidieron ${emb?.llamadas} embeddings de consulta para solo ${emb?.unicos} textos distintos`,
    detalle: 'La misma consulta se vuelve a embeber en cada búsqueda y en cada usuario: costo y latencia evitables con una caché.',
  });
  push(parcial, { id: 'G-PARCIAL', severidad: 'INFO', titulo: `La corrida terminó antes de tiempo: ${motivoParada || 'interrumpida'}`, detalle: 'Los resultados son parciales.' });
  return out;
}

module.exports = {
  analizarRampa, analizarLock, analizarStampede, analizarMega, analizarCarga, hallazgosGlobales,
  evaluarPaso: filaRampa,
};
