# Nota de entrega · Agente 3 (Cartógrafo web) → Agente 05 (Frontend / Storytelling)
_24 nov 2026 · primer mapa: "Oportunidades" (mapa de calor en malla de puntos)_

## Qué dejé en `Sitio_web/`
| Archivo | Dueño | Estado |
|---|---|---|
| `js/mapa.js` | Agente 3 | Listo. Crea el mapa y expone la API `Mapa` (abajo). |
| `mapas/*.geojson` | Agente 3 | Listo. 10 capas, EPSG:4326, ≈3.2 MB en total. |
| `index.html` | Agente 05 | **Mínimo provisional** para poder ver el mapa: cabecera, `#mapa`, `#escenas` con la escena 02, riel. Trae un `<script>` en línea que conecta las pestañas y dibuja las barras de "A 60 minutos de casa"; reemplázalo con `scrollytelling.js` y `charts_d3.js`. |
| `css/styles.css` | Agente 05 | Copia íntegra de `Design_system/tokens.css` (v0.2) + un bloque "SITIO · componentes" al final (panel, pestañas, barras, sellos, leyenda, popup, riel). Solo usa alias/específicos. |
| `herramientas/hacer_capas.py` | Agente 3 | Script que generó las capas desde las salidas del Agente 2 (`shapely` + `pyproj`). |
| `img/vista_previa_mapa_calor.png` | — | Captura de escritorio (1440 px). |

**Para verlo:** el navegador no deja leer GeoJSON con doble clic. En una terminal:
`cd Sitio_web && python3 -m http.server 8000` y abrir `http://localhost:8000`.

## API pública de `mapa.js`
```js
Mapa.iniciar('mapa')            // una vez; devuelve una promesa con el objeto maplibre
await Mapa.listo                // se resuelve cuando todas las capas están cargadas
Mapa.escena({ capas:[...], encuadre:'trayecto', categoria:'empleo' })   // lo que llamará scrollytelling.js
Mapa.mostrar('isocrona60')  /  Mapa.ocultar('isocrona60')
Mapa.categoria('escuelas')      // empleo | escuelas | salud | cultura (cambia malla, leyenda y popup)
Mapa.encuadre('ecatepec')       // o [[oeste,sur],[este,norte]]; deja espacio al panel de texto
Mapa.mapa                       // el mapa MapLibre por si hace falta algo más
Mapa.visibles                   // grupos encendidos
```
`escena()` apaga todo grupo que no esté en `capas`. Si no mandas `capas`, no toca la visibilidad.
Evento: `#mapa` dispara `mapa:categoria` (detail = nombre) al cambiar de categoría, por si una gráfica quiere seguirla.

### Grupos de capas (lo que va en `capas`)
| Grupo | Qué prende |
|---|---|
| `base` | áreas verdes, agua, vías rápidas y primarias, límites de alcaldías (punteado), nombres de avenidas (zoom ≥ 13.5) |
| `etiquetas` | nombres de alcaldías (HTML, Plex Mono) y zonas de destino (aparecen con zoom ≥ 11.6) |
| `transporte` | otras líneas de Metro, Mexibús y Mexicable (gris, discontinuo) |
| `linea3` | Metro Línea 3 + estación y sello "Indios Verdes" |
| `ecatepec` | municipio de Ecatepec achurado en neón + sello "Ecatepec" |
| `oportunidades` | malla de puntos (tamaño + color) + sello "+ empleo · Centro / Reforma" (solo en Empleo) |
| `isocrona60` | línea punteada de 60 min desde Ecatepec + rótulo "60 min →" |

### Encuadres con nombre
`zmvm` (CDMX + Ecatepec) · `trayecto` (Centro ↔ Ecatepec, el de la escena 02) · `ecatepec` · `centro`.

## Cómo se conecta con `guion_escenas.json` y `scrollytelling.js`
Propuesta de una entrada del guion (los campos de mapa son los que entiende `Mapa.escena`):
```json
{ "id": "02", "titulo": "Oportunidades",
  "mapa": { "capas": ["base","etiquetas","transporte","linea3","ecatepec","oportunidades","isocrona60"],
            "encuadre": "trayecto", "categoria": "empleo" },
  "grafica": "barras_60min" }
```
En `scrollytelling.js`: cuando entre la escena N → `Mapa.escena(guion[N].mapa)`. Esperar `Mapa.listo` antes de la primera llamada.

## Capas en `mapas/`
| Archivo | Contenido | Campos |
|---|---|---|
| `oportunidades_malla.geojson` | 4,213 puntos: centros de hexágonos de ≈520 m con lo que hay dentro. Incluye `metadatos.cortes` (quintiles) para la leyenda. | `empleos` (estimado), `escuelas`, `salud`, `cultura`, `zona` (alcaldía/municipio), `c_empleo` `c_escuelas` `c_salud` `c_cultura` (clase 0–5) |
| `isocrona_60min.geojson` | A dónde se llega en ≤ 60 min desde al menos una de las 20 colonias más pobladas de Ecatepec (combi + transporte público, día laborable 6:30–7:30) | `minutos`, `descripcion` |
| `colonias_origen.geojson` | Las 20 colonias de Ecatepec del modelo | `colonia`, `poblacion`, `mujeres`, `t_mediana`, `pct_empleo_60` (% de empleos alcanzables en 60 min) |
| `limites.geojson` | 16 alcaldías + Ecatepec | `nombre`, `entidad` (CDMX/Edomex) |
| `vialidades.geojson` | Vías rápidas (1) y primarias (2) | `nombre`, `clase` |
| `transporte.geojson` | Metro, Mexibús, Mexicable | `sistema`, `linea`, `nombre` |
| `agua.geojson`, `areas_verdes.geojson` | Fondo (solo polígonos grandes, simplificados) | — |
| `etiquetas_alcaldias.geojson`, `lugares.geojson` | Puntos para rótulos (Indios Verdes, Ecatepec, 20 destinos) | `nombre`, `tipo`, `t_mediana` |

Cifras clave (reales, del modelo del Agente 2): con 60 min de viaje, la colonia mejor conectada alcanza el **28.5 %** de los empleos, la típica el **9.5 %** y la peor el **1.9 %**. Juntando las 20 colonias se cubre el 36.1 %.

## Tokens del design system que usa el mapa
Se leen en vivo con `getComputedStyle` desde `#mapa` (que lleva `data-modo="dia"`), así que si cambian en `styles.css` el mapa cambia solo:
`--map-fondo`, `--map-halo`, `--map-etiqueta(-fuerte)`, `--map-limite`, `--map-zona-foco`, `--map-linea3`, `--c-superficie` (vialidades), `--c-texto`, `--c-texto-2`, `--data-seq-1…5` (malla), `--p-tinta`, `--p-l3`, `--p-luz`, `--p-vapor` (leyenda y popups oscuros), `--sello-*`, `--cinta`, `--riel-*`, `--grano-opacidad`.

## Decisiones y pendientes
- Malla de puntos con **tamaño y color redundantes** (rampa secuencial del design system, monótona en luminosidad → se lee también sin color).
- Etiquetas en HTML (Plex Mono con halo del fondo) para que siempre queden encima de los puntos. Los nombres de avenidas usan glifos Noto Sans de Protomaps; si ese servidor falla, solo desaparecen esos nombres.
- "Salud" = sector DENUE "Salud y asistencia social" (no solo hospitales); por eso la pestaña no dice "Hospitales".
- Los nombres de colonias de Ecatepec vienen sin acentos desde el DENUE ("Valle De Aragon"); conviene corregirlos en el ETL.
- Solo hay isócronas de día. La escena 04 (Noche) necesita que el Agente 2 corra el horario nocturno.
- Este mapa no muestra datos de violencia. Cuando lleguen, deben entrar ya agregados (malla o colonia), nunca como puntos exactos.
