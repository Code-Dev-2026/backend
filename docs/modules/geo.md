# Módulo Geoespacial: Rutas, Paradas GiST y Geocercas (`RoutesModule`)

- **Issue de referencia:** `#6` — *feat(geo): modelado geoespacial de rutas escolares, paradas GiST y geocercas en PostGIS* (cerrada).
- **Fuentes en el código:**
  - `src/modules/routes/` (`routes.module.ts`, `routes.controller.ts`, `geo-zones.controller.ts`, `routes.service.ts`, `geo-zones.service.ts`, `route-assignment.service.ts`, `domain/*`, `dto/*`, `infrastructure/postgis-geo.repository.ts`, `infrastructure/in-memory-geo.repository.ts`)
  - DDL asociado: `db/migrations/V004__geospatial_routes_and_zones.sql`, `db/migrations/V013__geo_san_benito_geofence.sql` y `db/migrations/undo/U013__geo_san_benito_geofence.sql`

---

## 1. Propósito

Administrar el trazado oficial de rutas escolares (`ruta`), las paradas georreferenciadas en orden secuencial con geocercas perimetrales (`parada`), las zonas geográficas/geocercas (`zona_geografica`, incluyendo la sede del Colegio San Benito del Otún en Pereira) y las asignaciones biunívocas de estudiantes a rutas (`asignacion_ruta`), ofreciendo consultas espaciales de proximidad y contención sobre **WGS84 (SRID 4326)**.

---

## 2. Entidades, Puertos y Tablas

### Tablas DDL (`V004` + `V013`)

| Tabla | Geometría nativa (`SRID 4326`) e índices | Reglas de integridad en BD |
| --- | --- | --- |
| `ruta` | `polilinea_oficial GEOGRAPHY(LineString, 4326)` + índice `GiST` | `codigo` único; `jornada IN ('MANANA', 'TARDE', 'COMPLETA')`; FKs a `colegio` y `empresa_transportadora`. |
| `parada` | `punto_geografico GEOGRAPHY(Point, 4326)` + `radio_geocerca GEOGRAPHY(Polygon, 4326)` (ambas con `GiST`) | `orden_secuencia > 0` (`V013`); únicos `(id_ruta, orden_secuencia)` y `(id_ruta, id_parada)`. |
| `asignacion_ruta` | — | FKs compuestas `fk_asignacion_subida_compuesta` y `fk_asignacion_bajada_compuesta` a `parada(id_ruta, id_parada)`; índice único parcial `uq_estudiante_asignacion_franja (id_estudiante, ciclo_horario) WHERE activa = TRUE`. |
| `zona_geografica` | `poligono GEOGRAPHY(Polygon, 4326)` + índice `GiST` | `tipo_zona IN ('SOMBRA_CELULAR', 'GEOCERCA_ESCOLAR', 'PERIMETRO_MUNICIPAL')`; `V013` agrega `codigo` (único parcial), `id_colegio` opcional y semilla `GEOCERCA-SAN-BENITO-OTUN` (`~300m x 300m` centrada en `4.8143, -75.6946`, Pereira). |

### Segregación de interfaces (ISP) y persistencia

- **`IRouteDefinitionService`** (`RoutesService`): definición logística de rutas y paradas.
- **`IGeoProximityQueries`** (`GeoZonesService` → repositorio): consultas espaciales (`ST_DWithin`, `ST_Distance`, `ST_Contains`).
- **Selección de repositorio (`RoutesModule`):** controlada por `GEO_USE_POSTGIS`:
  - `true` → `PostgisGeoRepository` (`pg.Pool` con SQL nativo PostGIS).
  - `false` (valor por defecto) → `InMemoryGeoRepository` (Haversine sobre esfera media WGS84 y ray-casting inclusivo de bordes).

---

## 3. Endpoints HTTP

Todos los endpoints requieren JWT (`JwtAuthGuard`).
- **Roles de gestión (`ROUTE_MANAGEMENT_ROLES` / `GEO_MANAGEMENT_ROLES`):** `ADMIN`, `RECTORIA`, `GERENCIA_TRANSPORTE`, `JEFE_OPERACIONES`.
- **Roles de lectura (`ROUTE_READ_ROLES` / `GEO_READ_ROLES`):** los anteriores más `MONITORA`, `CONDUCTOR` y `ACUDIENTE`.

### Rutas, Paradas y Asignaciones (`RoutesController`, prefijo `/api/v1/routes`)

| Método y Ruta | Roles | Descripción y respuestas clave |
| --- | --- | --- |
| `POST /api/v1/routes` | Gestión | Crea ruta con `polilinea_oficial` GeoJSON `LineString` (`201`, `400`, `409` código duplicado). |
| `GET /api/v1/routes` | Lectura | Lista rutas escolares con filtros opcionales (`ListRoutesQueryDto`). |
| `GET /api/v1/routes/:id` | Lectura | Detalle de ruta (`srid: 4326`) y sus paradas ordenadas (`200`, `404`). |
| `PATCH /api/v1/routes/:id` | Gestión | Actualiza definición o polilínea (`200`, `404`). |
| `DELETE /api/v1/routes/:id` | Gestión | Elimina ruta sin dependencias (`204`, `404`, `409` si tiene asignaciones/viajes). |
| `POST /api/v1/routes/:id/stops` | Gestión | Agrega parada (`Point` + `Polygon` o autogenera polígono circular de 24 vértices con `radio_metros`, default `100 m`) (`201`, `409` secuencia duplicada). |
| `GET /api/v1/routes/:id/stops` | Lectura | Lista paradas de la ruta en orden ascendente por `orden_secuencia`. |
| `PATCH /api/v1/routes/:id/stops/:stopId` | Gestión | Actualiza parada o regenera geocerca (`200`, `404`, `409`). |
| `DELETE /api/v1/routes/:id/stops/:stopId` | Gestión | Elimina parada (`204`, `404`, `409` si tiene asignaciones). |
| `POST /api/v1/routes/:id/assignments` | Gestión | Asigna estudiante a ruta validando FK compuesta `(id_ruta, id_parada)` (`201`, `422` parada de otra ruta, `409` franja duplicada). |
| `GET /api/v1/routes/:id/assignments` | Gestión + `MONITORA` | Lista asignaciones activas de la ruta. |
| `DELETE /api/v1/routes/:id/assignments/:assignmentId` | Gestión | Desactiva asignación (`activa = FALSE`, `204`, `404`, `409` si ya inactiva). |

### Zonas Geográficas y Proximidad (`GeoZonesController`, prefijo `/api/v1/geo`)

| Método y Ruta | Roles | Descripción |
| --- | --- | --- |
| `POST /api/v1/geo/zones` | Gestión | Crea zona geográfica con GeoJSON `Polygon` cerrado (`201`, `400`, `409` código duplicado). |
| `GET /api/v1/geo/zones` | Lectura | Lista zonas/geocercas (`tipo_zona`, `activa`). |
| `GET /api/v1/geo/zones/school-geofence` | Lectura | Consulta geocerca oficial `GEOCERCA-SAN-BENITO-OTUN`. |
| `GET /api/v1/geo/zones/:id` | Lectura | Consulta zona por UUIDv7. |
| `PATCH /api/v1/geo/zones/:id` | Gestión | Actualiza zona/polígono. |
| `DELETE /api/v1/geo/zones/:id` | Gestión | Elimina zona (`204`). |
| `GET /api/v1/geo/proximity/stops` | Lectura | Paradas dentro de `radio_metros` ordenadas por distancia (`ST_DWithin` + `ST_Distance` GiST). |
| `POST /api/v1/geo/proximity/distance` | Lectura | Distancia geodésica en metros entre dos coordenadas WGS84 (`ST_Distance`). |
| `POST /api/v1/geo/proximity/contains` | Lectura | Zonas activas que contienen el punto (`ST_DWithin(..., 0)` + `ST_Contains`). |
| `POST /api/v1/geo/proximity/school-geofence/check` | Lectura | Verifica si un punto está dentro de la geocerca del Colegio San Benito del Otún. |
| `POST /api/v1/geo/proximity/stops/:stopId/contains` | Lectura | Verifica si un punto está dentro de la geocerca de la parada y retorna `distancia_metros`. |

---

## 4. Reglas de Negocio

- **Coherencia biunívoca ruta–parada:** `RouteAssignmentService` rechaza nuevas asignaciones si la ruta está inactiva (`400`) y delega la integridad de `(id_ruta, id_parada_subida)` y `(id_ruta, id_parada_bajada)` a PostgreSQL (`SQLSTATE 23503` → `422 Unprocessable Entity`).
- **Unicidad de franja horaria:** no se permite asignar al mismo estudiante dos veces activamente en la misma franja (`IDA`, `RETORNO`, `AMBOS`) (`409 Conflict`).
- **Geocerca automática de parada:** si `POST /routes/:id/stops` omite `radio_geocerca`, `createCircularGeofencePolygon` genera un anillo GeoJSON cerrado antihorario de 24 segmentos con `radio_metros` (por defecto `100 m`).
- **Semilla de sede escolar:** tanto `V013` como `InMemoryGeoRepository` precargan `GEOCERCA-SAN-BENITO-OTUN` en Pereira (`4.8143, -75.6946`).

---

## 5. Decisiones de Seguridad y Rendimiento

- **Validación estricta WGS84 (`OWASP ASVS V5.1`):** todas las entradas validan latitud en `[-90, 90]`, longitud en `[-180, 180]`, `LineString` con `>= 2` posiciones y `Polygon` con anillo cerrado de al menos 4 posiciones y `>= 3` vértices distintos.
- **Consultas GiST sin degradación:** `PostgisGeoRepository` filtra primero mediante `ST_DWithin` sobre columnas `geography` indexadas con `GiST`. En pruebas de contención puntual, aplica `ST_DWithin(poligono, punto, 0)` (aprovechando GiST) seguido de `ST_Contains(poligono::geometry, punto)`.
- **Validación de UUIDs:** todos los parámetros de ruta pasan por `ParseUUIDv7Pipe`.

---

## 6. Cómo Probarlo

```bash
npx jest src/modules/routes
```

*(Comprobado: 2 suites aprobadas —`routes.service.spec.ts` y `routes.http.spec.ts`—, 1 suite omitida —`postgis-geo.repository.integration.spec.ts`, que requiere PostgreSQL/PostGIS activo—; 14 pruebas aprobadas, 3 omitidas.)*
