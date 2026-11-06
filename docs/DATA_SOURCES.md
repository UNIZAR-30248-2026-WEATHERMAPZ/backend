# WeatherMapZ Backend - Fuentes de datos

Fuentes usadas por los imports de la PBI-3 y de la PBI-10 (`npm run import:all`). Los endpoints, conteos y campos
se verificaron contra los servicios reales el 2026-10-06. Vuelve a comprobarlos antes de fiarte de
estas cifras.

## Atribución (obligatoria)

Cualquier producto o documento que muestre estos datos debe incluir:

- "Origen de los datos: Ayuntamiento de Zaragoza (IDEZAR), edificios: vigencia 2026-10-01;
  arbolado: inventario 2022 (capa `arboles_2022`)"
- "© OpenStreetMap contributors, ODbL"

## Resumen

| Dataset | Fuente | Capa / consulta | Elementos (fuente) | CRS nativo | Licencia |
| --- | --- | --- | --- | --- | --- |
| Edificios | WFS de IDEZAR | `citygml3d:building` | 38.963 | EPSG:25830 | Condiciones de reutilización del Ayuntamiento de Zaragoza |
| Árboles | WFS de IDEZAR | `idezar_base:arboles_2022` | 172.543 | EPSG:25830 | Condiciones de reutilización del Ayuntamiento de Zaragoza |
| Red peatonal | OpenStreetMap (API Overpass) | vías `highway` transitables a pie dentro del término municipal | 44.676 vías (91.872 tramos importados) | EPSG:4326 | ODbL 1.0 |
| Zonas verdes (PBI-10) | OpenStreetMap (API Overpass) | `leisure=park` y `leisure=garden` públicos dentro del término municipal | 793 (2026-11-06) | EPSG:4326 | ODbL 1.0 |

Todos los imports piden o reciben coordenadas WGS84 y las guardan en EPSG:4326.

## Uso en el cálculo de sombras (PBI-5.2)

Las sombras usan las huellas y `height_m` de `buildings`, y el punto, `height_m` y
`crown_diameter_m` de `trees`. Los cálculos métricos transforman temporalmente las geometrías a
EPSG:25830; los datos almacenados siguen en EPSG:4326.

No se incorpora ninguna fuente nueva ni una supuesta API municipal de sombras. Los edificios
conservan `height_source` (`measured`, `floors_estimate` o `default`) y `height_suspicious` en el
resultado para que el consumidor conozca su procedencia. Los árboles sin altura (15.545 en la
medición de 2026-10-06) o sin diámetro de copa (138.836) se omiten y se contabilizan por motivo;
no se les asigna un valor por defecto. Los conteos pueden cambiar cuando se vuelva a importar la
fuente y `getUrbanDataQuality()` devuelve el estado presente de la base de datos.

## WFS de IDEZAR (Ayuntamiento de Zaragoza)

- Endpoint: `https://idezar-sig.zaragoza.es/servicios/geoserver/wfs` (GeoServer, WFS 2.0.0).
  Las capabilities indican `Fees: NONE` y `AccessConstraints: NONE`; no hace falta clave de API.
- Salida usada: `outputFormat=application/json`, `srsName=EPSG:4326`.
- Paginación: `startIndex`/`count` con `sortBy` por el identificador de la capa
  (`ImplementsResultPaging` es `TRUE`; `CountDefault` es 1.000.000). El `numberMatched` de la
  primera página es el número de elementos de la fuente.
- Condiciones de reutilización: el catálogo enlaza al aviso legal del Ayuntamiento. No son una
  licencia estándar; permiten la reutilización comercial y no comercial siempre que se cite la
  fuente ("Origen de los datos: Ayuntamiento de Zaragoza"), se indique la fecha de la última
  actualización, no se desnaturalice el sentido de los datos y no se sugiera respaldo municipal.

Nota: `https://idezar.zaragoza.es/geoserver` es otro GeoServer distinto que solo publica capas de
ruido y densidad. No contiene edificios ni árboles.

### Edificios: `citygml3d:building`

Resumen de la capa: "Huellas 2D de edificaciones con atributos urbanísticos (ref. catastral,
plantas, altura, uso, año). Fuente: Catastro INSPIRE BU. EPSG:25830."

| Campo | Uso |
| --- | --- |
| `identifier` (p. ej. `ES.SDGC.BU.3512704XM8231D01`) | `buildings.source_id`, orden de paginación |
| `measured_height` (decimal, m) | `height_m`, salvo que sea claramente errónea (ver abajo) |
| `storeys_above_ground` (short) | `floors`; altura de sustitución cuando `measured_height` es errónea |
| geometría (`Polygon` / `MultiPolygon`) | `geom`, guardada como `MultiPolygon` |
| `cadastral_reference`, `function`, `year_of_construction`, `num_viviendas`, `vigencia` | aún no se importan |

`vigencia` valía `2026-10-01` en todos los elementos de la muestra. El servicio no documenta cómo
se obtuvo `measured_height`.

#### Cómo se obtiene `height_m`

Se conserva la altura medida salvo que sea claramente errónea. Es errónea si está por debajo de
2 m o por encima de 150 m; con 2 o más plantas, si queda por debajo de 2 m o por encima de 8 m por
planta; con una planta (o sin número de plantas), si supera los 40 m. Una altura errónea o
ausente se sustituye por `plantas × 3 m + 1 m`. Todos los límites son inclusivos y se configuran
en `importConfig.height`. La regla completa, con la justificación de cada umbral, está en el
ADR-001 del
[docs/DECISIONS.md](../../docs/DECISIONS.md#adr-001--altura-de-los-edificios-buildingsheight_m)
del workspace.

| `height_source` | Significado | Edificios (2026-10-06) |
| --- | --- | --- |
| `measured` | `measured_height` aceptada tal cual | 38.712 |
| `floors_estimate` | `measured_height` ausente o errónea; `plantas × 3 + 1` | 248 |
| `default` | ni altura utilizable ni plantas; 4 m | 3 |

`height_suspicious` vale `true` en 727 alturas aceptadas pero atípicas (una planta y más de 15 m, o
más de 6 m por planta). Solo las marca para revisión; no cambia `height_m`.

### Árboles: `idezar_base:arboles_2022`

| Campo | Uso |
| --- | --- |
| `ID` (string) | `trees.source_id`, orden de paginación |
| `ESPECIE` | `species` (null si está vacío: 14.640 árboles, 8,5 %) |
| `ALTTOTAL` (string, m) | `height_m` (null si está vacío: 15.545 árboles, 9,0 %) |
| `DIAMCOPA` (string, m) | `crown_diameter_m` (null si está vacío: 138.836 árboles, 80,5 %) |
| geometría (`Point`) | `geom` |
| `EDADREL`, `FECHAPLANT`, `MATRICULA` | no se importan |

## OpenStreetMap vía Overpass

- Endpoint: `https://overpass-api.de/api/interpreter` (configurable con `OVERPASS_URL`).
- Área: `boundary=administrative`, `admin_level=8`, `ref:ine` que empieza por `50297` (Zaragoza).
- Vías: `highway` en footway, pedestrian, path, steps, living_street, residential, service,
  tertiary, secondary, primary, unclassified, cycleway, track; excluyendo `foot=no` y
  `access=private`. La consulta se construye en `src/integrations/osm/streetNetwork.js`.
- Número de elementos de la fuente: número de vías de la respuesta de Overpass (Overpass devuelve
  todo el resultado en una sola respuesta; no hay un `numberMatched` aparte).
- Licencia: Open Database License (ODbL) 1.0. Atribución "© OpenStreetMap contributors".

### Zonas verdes (PBI-10): `npm run import:green-areas`

- Misma API y misma área (`ref:ine` `50297`) que la red peatonal.
- Elementos: vías y relaciones `type=multipolygon` con `leisure=park` o `leisure=garden`,
  excluyendo `access=private` y `access=no`, con `out geom`. La consulta se construye en
  `src/integrations/osm/greenAreas.js`; el mapeador vuelve a comprobar los dos filtros.
- Geometría: los anillos (la vía cerrada, o las vías miembro de la relación) se envían como
  MultiLineString y PostGIS los une con `ST_BuildArea` (con agujeros) y `ST_MakeValid`. Se guardan
  en `green_areas` como MultiPolygon en EPSG:4326 con `source_id` `way/<id>` o `relation/<id>`.
- Rechazos: `not_green_area`, `not_public`, `unsupported_element`, `missing_geometry`, `open_way`
  (vía sin cerrar), `outside_zaragoza_bbox` e `invalid_geometry` (anillos que no forman área).
- Medición del 2026-11-06: 793 elementos, 793 importados (365 `park`, 722 ha; 428 `garden`,
  55 ha), 0 rechazados. En una descarga exploratoria del mismo día sin el filtro de acceso (área
  por nombre en vez de `ref:ine`) había 837 elementos, de ellos 39 jardines `access=private`,
  2 jardines y 1 parque `access=no`; la diferencia de 2 elementos entre esa descarga y el import
  no se ha investigado.
- Licencia y atribución: las mismas que la red peatonal (ODbL 1.0, "© OpenStreetMap
  contributors").
- Particularidades medidas: el bulevar central de Gran Vía está etiquetado como `leisure=park`
  (`way/1065467174`, 1,5 ha), así que cuenta como zona verde. El Parque Lineal de Plaza
  (`way/47376270`, 71,4 ha) no tiene ningún árbol del inventario de IDEZAR dentro; no se ha
  verificado si no tiene árboles o si el inventario no lo cubre. Los demás parques grandes sí
  tienen árboles (Parque del Agua 5.691, Parque Grande 5.089). Ver ADR-026.

## Fuentes evaluadas y no usadas

| Fuente | Resultado |
| --- | --- |
| `urbanismo:Alturas_Edificios` (IDEZAR) | 179.690 **puntos** con una etiqueta de texto (`etiqueta`, p. ej. `ZV`). No hay polígonos de edificios y el significado de la etiqueta sigue sin verificar, así que no se usa. |
| WFS INSPIRE del Catastro (`ovc.catastro.meh.es/INSPIRE/wfsBU.aspx`) | Funciona y tiene `numberOfFloorsAboveGround`, pero está limitado a 4 km² por petición (un cuadrado de 500 m devolvió 4,7 MB). IDEZAR ya publica huellas derivadas del Catastro con alturas. |
| Edificios / árboles de OSM | 18.137 edificios, solo 25 con `height`; 4.482 nodos `natural=tree`. Mucho menos completo que IDEZAR. |
| `idezar_base:arboles_urbanismo` | 233.995 símbolos cartográficos (`TXT_LABEL`, color, ángulo); sin atributos de árbol. |
| `infraestructuraverde:reposicion` | Trabajos de reposición de arbolado, no el inventario de árboles. |
