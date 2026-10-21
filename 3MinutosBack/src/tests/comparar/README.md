# Comparador antes / después

Mide si los cambios de búsqueda (varios candidatos, ancla léxica, corral de categoría, frescura al 40 %) y las reglas
de elegibilidad (nada de más de 24 h, importancia mínima, temas oficiales por etiqueta, país en Sociedad, sin repetir
la misma historia) mejoran respecto de la versión anterior, **contra tu base real y sin escribir nada**.

## Uso rápido

```bash
cd 3MinutosBack
npm run test:unit                              # tests de la lógica (sin base), segundos
npm run test:comparar -- todo --rapido         # ~20 temas, para ver que todo ande
npm run test:comparar                          # completo: 45 oficiales + 150 libres más pedidos
```

Abrí `test-resultados/reporte.html` (o agregá `--abrir`). También queda `comparacion.csv` para planilla.

## Qué hace `todo`

1. **Copia el código de antes** (`git worktree`, commit `32cac1e`) en una carpeta hermana del repo
   (`<repo>-baseline`). Se crea una sola vez. Con `--baseline <commit>` podés comparar contra otro.
2. **Arma los temas**: los 7 oficiales + 38 subtemas, y los temas libres más pedidos según
   `user_preferences` (usuarios activos, agrupados sin importar mayúsculas/tildes). Si no hay datos usa una lista de ejemplo.
3. **Corre cada versión** llamando a `pickBestArticlePerTopic` tema por tema, igual que producción pero sin
   curación, sin `DigestTestLog` y sin historial de usuario. Las dos ven la misma base y **las mismas respuestas de OpenAI**
   (caché en disco), así la única diferencia es el código.
4. **Compara** y genera el reporte.

Es de **solo lectura**: Mongo se abre con `autoIndex/autoCreate` apagados y OpenAI solo se usa para la expansión de consulta,
el embedding de la consulta y (opcional) un juez de relevancia. Costo aproximado de la primera corrida completa: centavos.

## Cómo leer el reporte

Cada tema termina en **una** de estas categorías (de mejor a peor):

| Categoría | Significa |
|---|---|
| **En tema** | Entregó una noticia que trata del tema |
| **Parcial** | Lo menciona sin ser el foco (en oficiales: categoría correcta pero otro subtema) |
| **Rescate** | No encontró nada y mostró una «noticia sugerida» (el usuario lo ve avisado) |
| **Sin noticia** | No entregó nada |
| **Fuera de tema, sin aviso** | Entregó como si fuera del tema algo que no lo es. **Es la falla más grave** |

- **Temas libres:** la relevancia la juzga `gpt-4o-mini` con título y resumen (`--sin-juez` la reemplaza por una mención del
  tema en el título). El título y el resumen van en texto plano (sin etiquetas ni entidades de la bajada del feed) y la
  mención del tema se mide sobre ese mismo texto. Es una guía: **revisá a mano** las secciones «Mejoran» y «Empeoran», que
  traen los logs de cada versión.
- **Temas oficiales:** no usan juez; se compara la categoría y el subtema que le asignó el clasificador. La versión nueva los
  lee por etiqueta (zona `ETIQUETA`, sin score); la anterior los resolvía con la búsqueda por significado.
- **Chequeos de cordura:** cosas que deben cumplirse siempre (la versión nueva no entrega nada de más de 24 h — la anterior
  permitía 48 h —, importancia de 40 o más y de 50 o más en el rescate, Sociedad solo de Argentina o Global, categoría
  correcta, corral respetado, `DigestTestLog` guarda los campos nuevos…). Si alguno falla es un bug, no una cuestión de gusto.
  Los de importancia y país solo se miden si la corrida guardó esos datos (las corridas viejas no los tienen).
- **Veredicto:** criterio orientativo (`MEJORA`, `REVISAR`, `EMPEORA`, `SIN CAMBIOS`). Los números van al lado.
- **Frescura:** se compara solo en los temas donde **las dos** versiones entregaron una noticia en tema. El reporte muestra
  cuántas quedan dentro de las 6 y de las 12 h, cuántas pasan de 24 h y cuál es la más vieja de todas.
- **Sustancia:** qué porcentaje de las noticias en tema son «buenas» (importancia de 50 o más) y cuántas quedaron por debajo del piso de 40.
- **Vigencia (veredicto):** falla si la versión nueva entrega algo de más de 24 h; es una mejora si la anterior se pasaba y la nueva no.

## Probar otros valores (por ejemplo el peso de frescura)

Cambiá `FINAL_WEIGHTS` en `src/embeddings/searchArticlesBySimilarityAtlas.js` y corré solo la versión nueva con otro nombre:

```bash
npm run test:comparar -- correr despues --etiqueta despues_f25
npm run test:comparar -- comparar antes despues_f25 --abrir
npm run test:comparar -- comparar despues despues_f25        # una variante contra la otra
```

La caché de OpenAI hace que esto sea casi instantáneo. Si las corridas cubren temas distintos, se comparan solo los comunes.

## Opciones útiles

| Opción | Efecto |
|---|---|
| `--rapido` | 14 oficiales + 15 libres |
| `--top 200` | cantidad de temas libres |
| `--temas-libres "a,b,c"` / `--archivo-temas f.txt` | tus propios temas libres |
| `--sin-juez` | no llama al juez IA |
| `--solo oficiales` / `--solo libres` | en `correr` |
| `--concurrencia 4` | temas en paralelo (bajalo si Atlas o OpenAI te limitan) |
| `--baseline <commit>` | contra qué versión comparar |
| `--reusar-temas` | no vuelve a leer `user_preferences` |

## Cosas a tener en cuenta

- **Corré las dos versiones en la misma tanda.** La frescura depende de la hora; `todo` ya lo hace. El reporte avisa si la base
  cambió más de 3 % entre corridas.
- Los resultados quedan en `test-resultados/` (ignorado por git). El tablero muestra commit y rama de cada corrida.
- Para borrar la copia de antes: `git worktree remove ../<repo>-baseline`.
- Si `npm ci` falla en la copia de antes, entrá a esa carpeta y corré `npm ci` a mano.
- La lista de temas oficiales (`temas.js`) es un espejo de `CATEGORIES` en `pickBestArticlePerTopic.js`; el reporte avisa si dejan de coincidir.

## Archivos

| Archivo | Rol |
|---|---|
| `cli.js` | comandos: `todo`, `setup`, `temas`, `correr`, `comparar` |
| `corrida.js` | proceso que corre **una** versión del código (se lanza una vez por versión) |
| `temas.js` | lista de temas oficiales y libres |
| `cache.js` | caché de OpenAI en disco |
| `metricas.js` | métricas, comparación y veredicto (lógica pura, con tests) |
| `reporte.js` | HTML, CSV y resumen por consola |
