# Test de estrés de 3Minutos

Somete **el código actual** del motor de búsqueda y del armado de digests a repetición, a carga y a entradas raras, y arma un reporte con los problemas que encuentra. No compara contra versiones anteriores.

Además de medir velocidad y estabilidad, comprueba **el contrato de una nota aceptable** en cada resultado que devuelve el motor:

- **Vigente:** menos de 24 h (la app no muestra la edad de la nota, así que una vieja parece nueva).
- **Sustancia:** importancia de 50 o más = "buena"; de 40 a 49 = "aceptable"; menos de 40, nunca. El rescate solo usa "buenas".
- **Temas oficiales** (categorías y subtemas): se leen por etiqueta (`matchZone = ETIQUETA`, sin score). La categoría no rescata nunca; el subtema rescata solo con una nota "buena" de su categoría.
- **Sociedad** solo con notas de Argentina o de alcance Global. Sin opinión, sin previas ni agenda.
- **Sin repetir:** ni una URL ya vista, ni "la misma historia" (embeddings con coseno ≥ 0,88) contra lo visto en las últimas 48 h (hasta 150 notas) o lo ya elegido en el mismo digest.

Corre contra el código de la rama que tengas descargada: en el código anterior marca los problemas de antes; en el de la rama del motor nuevo deberían desaparecer.

- **Solo lectura sobre Mongo.** No escribe nada (ver [Seguridad](#seguridad)).
- **Gasta OpenAI de verdad** (embeddings y expansión de consultas, con las claves de tu `.env`). Cuenta cada llamada y respeta un tope (`--max-openai`).
- **Pega contra tu Atlas real** (`$vectorSearch` + `$search`). Conviene correrlo fuera del horario pico.

## Cómo correrlo

```bash
git pull                                   # en la rama que quieras medir (tiene que incluir este test)
cd 3MinutosBack && npm install             # si hace falta

npm run test:estres -- --dry-run           # 1) mira el plan; NO se conecta a nada
npm run test:estres -- --nivel suave       # 2) unos minutos; primera señal
npm run test:estres -- --nivel medio       # 3) todos los oficiales + 40 libres, rampa hasta 16 en paralelo
npm run test:estres -- --nivel maximo      # 4) 150 libres, rampa hasta 64 en paralelo y 10 min de soak
```

Necesita en el `.env` (el mismo del servidor): `MONGODB_URI`, `OPENAI_API_KEY_EMBEDDINGS`, `OPENAI_API_KEY_REVIEW`.
Antes de conectar muestra **a qué host y base va a pegar** (sin usuario ni contraseña) y pide confirmación; `--si` la saltea.
**Ctrl+C** corta ordenadamente: termina lo que está en curso y arma el reporte con lo que haya (marcado como parcial).

Los reportes quedan en `3MinutosBack/test-resultados/estres-<nivel>-<fecha>/` (carpeta ignorada por git):
`reporte.html` (abrirlo en el navegador), `hallazgos.csv`, `topicos_A.csv` y `estres.json` (todo el detalle).

## Niveles

| | suave | medio | máximo |
|---|---|---|---|
| tópicos oficiales | 7 categorías | los 45 | los 45 |
| tópicos libres (los más pedidos de `user_preferences`) | 10 | 40 | 150 |
| repeticiones por tópico (A) | 3 | 5 | 10 |
| paralelo base | 2 | 4 | 8 |
| rampa de carga (D) | 1 · 2 · 4 | 1 → 16 | 1 → 64 |
| soak (F) | no | no | 10 min |
| tope de llamadas a OpenAI | 1.500 | 12.000 | 60.000 |
| tope de duración | 15 min | 45 min | 120 min |
| orden de magnitud (con 1 usuario real; `--dry-run` calcula el tuyo) | ≈ 350 búsquedas · 4 min | ≈ 2.200 búsquedas · 15 min | ≈ 10.000 búsquedas · 35 min |

Cualquier número se pisa por la línea de comandos (ver [Opciones](#opciones)).

## Qué busca cada escenario

| | Qué hace | Qué problemas encuentra |
|---|---|---|
| **A · Repetición** | Cada tópico se consulta N veces con la misma entrada y sin historial. | Resultados que cambian de ida y vuelta (no determinismo), tópicos que a veces dan nota del tema y a veces rescate, **errores de búsqueda que se disfrazan de "noticia sugerida"**, la misma nota de relleno entregada a muchos tópicos, categorías sin nota. |
| **B · Sesiones con historial** | Simula usuarios que refrescan: cada ronda le pasa al motor lo que el usuario ya vio (las URLs y los embeddings de hasta 150 notas, como producción). Un tópico solo, y usuarios de 3 tópicos. | **Notas repetidas**, notas que **reaparecen al salir del tope de 150**, cuándo se agota un tópico, notas "casi iguales" (misma historia) entregadas al mismo usuario (con embeddings reales de Mongo si están). |
| **C · Tríos solapados** | Digests de 3 tópicos que se pisan (categoría + subtemas, tríos reales de usuarios) en las 6 permutaciones. | La misma nota o la misma historia en dos tópicos del mismo digest, tópicos que reciben otra nota según su posición ("el 3.º recibe las sobras"). |
| **D · Carga y concurrencia** | Rampa de llamadas en paralelo (y de digests completos con usuarios reales), prueba del candado de `buildDigestForUser`, ráfaga sobre un tópico nuevo, una llamada con muchos tópicos. | **En qué escalón se degrada** (errores, latencia, event loop), 429 de OpenAI, fallos del pool de Mongo, candado que no agrupa o no se libera, cuántas expansiones paga una ráfaga, cuántos digests por minuto aguanta la cron. |
| **E · Hostiles y variantes** | Textos que un usuario o un bug del front podrían mandar (vacíos, gigantes, emoji, regex, operadores de Mongo, `constructor`…) y el mismo tópico escrito de 4-5 maneras. | **Excepciones o cuelgues** con un texto de usuario (crítico), búsquedas que se rompen por el texto, "River" / "RIVER" / "river" que se resuelven distinto. |
| **F · Soak** | Carga sostenida (solo en `maximo` o con `--soak-minutos`), con tópicos únicos que engordan la caché de expansiones. | Crecimiento de memoria, latencia que empeora con el tiempo, errores que aparecen con el tiempo. |
| **S · Auditoría estática** | Lee el código actual (no lo ejecuta). | Decisiones de diseño que explican lo medido (ver abajo). |

### Qué marca la auditoría estática

Salen de leer el código, no de medir; los escenarios dinámicos muestran su efecto real. La columna de la derecha dice si el código del motor nuevo todavía lo tiene.

| # | Hallazgo | ¿Sigue en el motor nuevo? |
|---|---|---|
| 1 | `searchArticlesBySimilarityAtlas` no proyecta `embedding` y el motor tampoco lo lee aparte: **el filtro de "misma historia" nunca bloquea nada** | No: el motor lee los embeddings de los finalistas |
| 2 | `buildDigestForUser` leía `history.titles`, pero el historial no lo devolvía (`alreadyShownTitles` llegaba siempre vacío y el motor no lo usaba) | Ya no hay hallazgo: se eliminó la lista de títulos sueltos (el título viaja con cada embedding) |
| 3 | El historial mira solo las últimas **30** notas vistas | No: 48 h, hasta 150 notas |
| 4 | Los clientes de OpenAI no tienen `timeout` ni `maxRetries` (rigen los del SDK: 10 min y 2 reintentos) | No en el camino del digest (la expansión, el embedding de la consulta y las preguntas a los jueces llevan los suyos) |
| 5 | La conexión a Mongo no fija `maxPoolSize` ni `socketTimeoutMS` | Sí |
| 6 | La caché de expansiones era un `Map` que solo crecía (y no deduplicaba pedidos simultáneos del mismo tópico nuevo; el escenario D mide cuántas expansiones paga una ráfaga) | No: `topicExpansion.js` tiene tope, vencimiento y comparte la llamada en curso |
| 7 | El rescate de los temas libres usaba una consulta fija por categoría ("<categoría> Argentina actualidad nacional"): todos los que fallaban recibían la misma nota | No: lee la categoría por etiqueta, como los temas oficiales, y a igual calidad prefiere el subtema y la categoría que sugirió la IA (sin consulta, así que tampoco depende de la búsqueda ni de OpenAI). El escenario A sigue midiendo cuántos tópicos terminan en la misma nota |
| 8 | `TOPIC_TO_CATEGORY[topic]` busca en un objeto común (`constructor`, `toString`… devuelven funciones), en el motor o en la ingesta | No |
| 9 | La cron genera los digests uno tras otro | Sí |
| 10 | **La app muestra el digest guardado sin volver a revisar la edad de sus notas** (una nota elegida a la mañana se sigue mostrando a la noche) | No: `ensureFreshDigest` revisa y reemplaza las vencidas |

## Opciones

| Opción | Qué hace |
|---|---|
| `--nivel suave\|medio\|maximo` | nivel de carga (por defecto `suave`) |
| `--dry-run` | muestra el plan y sale, sin conectarse a nada |
| `--si` | no pide confirmación (necesario si no hay terminal interactiva) |
| `--solo A,B` · `--saltar D,F` | elegir escenarios |
| `--repeticiones N` · `--rondas N` | repeticiones por tópico (A) · rondas por tópico y por sesión (B) |
| `--libres N` | cantidad de tópicos libres |
| `--concurrencia N` | paralelismo base de A, B, C y E |
| `--rampa 1,2,4,8` · `--concurrencia-max N` | escalones de la rampa D · tope de la rampa |
| `--seguir-tras-quiebre` | no cortar la rampa en el primer escalón que se quiebra |
| `--soak-minutos N` | duración del soak (F) |
| `--timeout S` | timeout por llamada, en segundos |
| `--max-openai N` · `--max-minutos N` | topes duros; al llegar, corta y entrega lo que haya |
| `--temas-libres "a,b,c"` · `--archivo-temas ruta` | usar tus propios tópicos libres |
| `--sin-usuarios` | no leer usuarios: se omiten los digests completos y la prueba del candado |
| `--cache-openai` | caché de OpenAI en disco (repetir sin costo; **oculta 429 y latencia real**) |
| `--semilla N` | misma semilla, mismos tópicos y mismo orden de muestreo |
| `--salida carpeta` · `--env ruta` | dónde guardar el reporte · qué `.env` usar |
| `--abrir` | abre el HTML al terminar |
| `--sin-estatico` | omite la auditoría estática |

Para el soak conviene correr con `--expose-gc` (el script `npm run test:estres` ya lo hace) así el heap es comparable entre muestras.

## Cómo leer el reporte

| Severidad | Significa | Ejemplos |
|---|---|---|
| 🔴 CRÍTICA | Una garantía básica se rompió. Frenar y mirar. | nota repetida dentro de la ventana de historial · la misma nota para 2 tópicos de un digest · una excepción con un texto de usuario · el candado no se libera · **el test emitió una escritura** |
| 🟠 ALTA | Falla visible para el usuario o el sistema se degrada. | nota de más de 24 h · importancia por debajo del piso · previa o agenda · nota de Sociedad de otro país · categoría equivocada · tema oficial con score en vez de etiqueta · errores de búsqueda disfrazados de rescate · resultados que oscilan · la rampa se quiebra · fuga de memoria |
| 🟡 MEDIA | Calidad o robustez a revisar. | rescate "monocultivo" · tópico que depende de su posición · lentitud · una ráfaga que paga varias expansiones |
| 🔵 BAJA / ⚪ INFO | Contexto: no requiere acción por sí solo. | cambio único de nota · `constructor` / `toString` como tópico · capacidad estimada de la cron · "no se quebró hasta N" |

Veredicto: 🔴 ROJO si hay alguna crítica · 🟠 NARANJA si hay altas · 🟡 AMARILLO si hay medias · 🟢 VERDE si no.

Para interpretar bien los números:

- La latencia es **la de tu máquina hacia Atlas y OpenAI**, no la de tu hosting.
- La curación de OpenAI (que reescribe títulos y **escribe en `Article`**) y el `DigestTestLog` están **simulados**, para no escribir. Por eso `D-CAPACIDAD-CRON` es un techo: en producción es más lento.
- Un "quiebre" de la rampa depende también de tu plan de Atlas (un cluster chico se satura antes) y de los límites (RPM/TPM) de tus claves de OpenAI. Si ves 429, el cuello de botella es OpenAI, no tu código.
- Con `--cache-openai` se repite sin costo pero se pierden los 429 y la latencia real de OpenAI: no usarlo para medir carga.
- El reporte incluye **tópicos de usuarios reales** (tríos de `user_preferences`), sin sus ids y sin el host de Mongo. No lo compartas públicamente sin revisarlo.

## Seguridad

Solo lectura, en tres capas:

1. Las escrituras de mongoose (`create`, `save`, `updateOne`, `deleteMany`, `insertMany`, `bulkWrite`, `findOneAndUpdate`, `syncIndexes`, …) **lanzan un error** en este proceso.
2. Se escuchan todos los comandos que salen hacia Mongo; si aparece uno de escritura (incluido `$out` / `$merge`), el reporte lo marca **CRÍTICO** (`G-ESCRITURAS`) y dice qué comando fue.
3. `generateNeutralCuration` y `DigestTestLog.create` — los dos únicos puntos de `buildDigestForUser` que escriben — están reemplazados por versiones que no escriben ni llaman a OpenAI. El resto del código es el real.

Límite conocido: el acceso directo al driver (`Model.collection.insertOne(...)`) no se bloquea, solo se detecta con la capa 2. El código actual no lo usa.
Los archivos del reporte no contienen el host ni credenciales de Mongo.

## Qué NO prueba

La API HTTP (rutas, autenticación, rate limits de Express), las notificaciones push, la ingesta ni la clasificación (la auditoría estática solo lee su código), ni el reemplazo de notas vencidas al abrir la app (eso lo cubren los tests unitarios de `staleDigest` y `rutasDigest`), y la curación de OpenAI (está simulada). Es el motor de búsqueda y el armado de digests.

## Los tests del propio script

`npm run test:unit` incluye 161 tests del script (`src/tests/unit/estres.*.test.js`). Usan un entorno 100 % falso (`estres.fake.js`): comprueban que cada hallazgo se detecta cuando se inyecta la falla y que **no** se inventan problemas cuando todo está sano, que el plan de `--dry-run` coincide con lo que los escenarios hacen, que cortar a la mitad deja un reporte parcial y que el CLI no filtra credenciales.

Además se corrió **una vez de punta a punta con un Mongo, un OpenAI y una red simuladas** (nada se conectó): el CLI real, `entorno.js`, la búsqueda híbrida, `pickBestArticlePerTopic` y `buildDigestForUser` reales, mongoose 9 real, el SDK real de OpenAI con `fetch` falso y las clases reales de eventos del driver `mongodb` 7.1. Corrieron los 6 escenarios, no se escribió nada, no hubo red ni credenciales en la salida, y esa corrida sacó a la luz (y se arreglaron) tres defectos del propio script. La corrida se repitió con el motor nuevo (temas oficiales por etiqueta, historial de 48 h con embeddings y reposición de notas vencidas al abrir el digest): sin violaciones de invariantes. Con el código de este PR la auditoría estática marca 2 hallazgos: el pool de Mongo (BAJA) y la cron secuencial (INFO).

**Lo que nunca se ejecutó es contra tu Atlas y tu OpenAI reales**: ahí pueden aparecer cosas que ningún simulador reproduce (latencias, 429, índices de Atlas Search, el comportamiento real de `$vectorSearch`). Si algo sale raro, el reporte lo marca como `X-ERROR-DEL-TEST` y conviene avisar con el mensaje completo.

## Estructura

```
estres/
  cli.js              punto de entrada (npm run test:estres)
  config.js           niveles, umbrales y tópicos hostiles
  entorno.js          ÚNICO archivo que se conecta a Mongo y OpenAI
  instrumentos.js     contadores, tope de OpenAI, bloqueo de escrituras, captura de logs, lag, memoria
  invariantes.js      lo que SIEMPRE debe cumplir un resultado (edad, importancia, etiqueta, país, categoría, repetidos…)
  analisis_*.js       analizadores puros: filas medidas → hallazgos
  escenarios/         A…F (usan solo el ctx que arma entorno.js)
  estatico.js         auditoría estática del código
  reporte*.js         JSON, CSV, HTML y resumen de consola
```
