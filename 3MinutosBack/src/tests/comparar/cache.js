'use strict';

/**
 * Caché en disco para las llamadas a OpenAI del comparador.
 *
 * Por qué: la expansión de consulta, el embedding de la consulta y el "juez" son
 * determinísticos (temperature 0). Si se cachean, la versión "antes" y la "después"
 * reciben EXACTAMENTE las mismas expansiones y vectores, así la única diferencia entre
 * las dos corridas es el código. Además las repeticiones salen gratis.
 *
 * Solo se parchean los dos clientes de OpenAI del proceso de prueba. No toca la base.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sleep } = require('./utilidades');

class CacheDisco {
  constructor(archivo) {
    this.archivo = archivo;
    this.mapa = new Map();
    this.aciertos = 0;
    this.fallos = 0;
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    if (fs.existsSync(archivo)) {
      for (const linea of fs.readFileSync(archivo, 'utf8').split('\n')) {
        if (!linea.trim()) continue;
        try {
          const { k, v } = JSON.parse(linea);
          this.mapa.set(k, v);
        } catch {
          // línea cortada por una corrida interrumpida: se ignora
        }
      }
    }
  }

  static clave(objeto) {
    return crypto.createHash('sha1').update(JSON.stringify(objeto)).digest('hex');
  }

  get(k) {
    if (this.mapa.has(k)) { this.aciertos++; return this.mapa.get(k); }
    this.fallos++;
    return undefined;
  }

  set(k, v) {
    this.mapa.set(k, v);
    fs.appendFileSync(this.archivo, `${JSON.stringify({ k, v })}\n`);
  }
}

async function conReintentos(fn, intentos = 4) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (error) {
      const status = error?.status;
      const reintentable =
        status === 429 || (status >= 500 && status < 600) ||
        /ETIMEDOUT|ECONNRESET|EAI_AGAIN|timeout/i.test(String(error?.message || ''));
      if (!reintentable || i >= intentos - 1) throw error;
      await sleep(1000 * 2 ** i);
    }
  }
}

function envolver(objetivo, metodo, cache) {
  const original = objetivo[metodo].bind(objetivo);
  objetivo[metodo] = async (params, ...resto) => {
    const k = CacheDisco.clave(params);
    const guardado = cache.get(k);
    if (guardado !== undefined) return guardado;
    const respuesta = await conReintentos(() => original(params, ...resto));
    // Se guarda como JSON plano: es lo único que leen el proyecto y el juez.
    const plano = JSON.parse(JSON.stringify(respuesta));
    cache.set(k, plano);
    return plano;
  };
}

/**
 * @param {object} cfg  módulo src/config/openai de la versión que se está probando
 * @param {string} dirCache
 */
function instalarCacheOpenAI(cfg, dirCache) {
  const chat = new CacheDisco(path.join(dirCache, 'openai_chat.jsonl'));
  const embeddings = new CacheDisco(path.join(dirCache, 'openai_embeddings.jsonl'));

  if (cfg.openaiReview?.chat?.completions) envolver(cfg.openaiReview.chat.completions, 'create', chat);
  if (cfg.openaiEmbeddings?.embeddings) envolver(cfg.openaiEmbeddings.embeddings, 'create', embeddings);

  return { chat, embeddings };
}

module.exports = { CacheDisco, instalarCacheOpenAI };
