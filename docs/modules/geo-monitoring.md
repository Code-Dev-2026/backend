# Motor de Detección de Desvíos de Ruta y Paradas Prolongadas en Streaming (`GeoMonitoringModule`)

- **Issue de referencia:** `#13` — *feat(geo): motor de detección de desvíos de ruta (>300m) y paradas prolongadas en streaming* (Milestone: *Sprint 3: Tiempo real y notificaciones*).
- **Fuentes en el código:**
  - `src/modules/geo-monitoring/` (`geo-monitoring.module.ts`, `geo-deviation-analyzer.service.ts`, `geo-security-incident-reporter.service.ts`)
  - Dominio: `domain/geo-monitoring.constants.ts`, `domain/geo-monitoring.types.ts`, `domain/polyline-distance.ts`, `domain/telemetry-anomaly-rule.interface.ts`, `domain/route-geometry-repository.port.ts`, `domain/geo-security-alert.port.ts`
  - Reglas (OCP): `rules/route-deviation.detector.ts`, `rules/prolonged-stop.detector.ts`
  - Adaptadores: `infrastructure/postgis-route-geometry.repository.ts`, `infrastructure/in-memory-route-geometry.repository.ts`, `infrastructure/coordination-geo-alert.adapter.ts`
  - Pruebas: `rules/anomaly-rules.spec.ts`, `geo-deviation-analyzer.service.spec.ts`, `infrastructure/postgis-route-geometry.repository.integration.spec.ts`, secuencias pre-grabadas en `__fixtures__/recorded-gps-sequences.ts`
  - Dependencias reutilizadas sin modificación: evento `telemetry.gps.recorded` y `InMemoryEventDispatcher` (Issue `#12`), tipos y geocercas de `src/modules/routes/domain/geo.types.ts` (Issue `#6`), `AttendanceRealtimeGateway` / sala `coordinacion` (Issues `#8`–`#10`), `AuditService` (bitácora SHA-256).
  - DDL usado (sin migración nueva): `ruta.polilinea_oficial` + índice GiST `idx_ruta_polilinea` y `parada.radio_geocerca` (`V004`), `viaje` (`V005`), `incidente` (`V006`), `tipo_notificacion` con `DESVIO_RUTA_SIGNIFICATIVO` y `DETENCION_PROLONGADA` sembrados (`V007`).

---

## 1. Propósito

Vigilar en tiempo real que el vehículo no abandone el trazado vial aprobado ni se detenga injustificadamente fuera de parada (`RF-15`, `RNF-05`). Por cada coordenada GPS persistida por la ingesta (`#12`) el motor:

1. Calcula la distancia perpendicular del vehículo a la polilínea de la ruta del viaje.
2. Detecta **desvío significativo**: distancia `> 300 m` confirmada en **3 lecturas consecutivas** y validada con `ST_DWithin` / `ST_Distance` geodésicos contra la polilínea oficial completa.
3. Detecta **detención prolongada**: velocidad `< 3 km/h` fuera de toda geocerca de parada durante `> 5 min`.
4. Registra un `incidente` `CRITICO`, lo encadena en la bitácora forense y emite la alerta crítica a Coordinación de forma inmediata.

> **Fuera de alcance:** análisis predictivo de accidentes; la entrega de notificaciones push a acudientes/coordinadores (tabla `notificacion`) corresponde al Issue `#15`, que consume el evento de dominio `geo.security.incident` publicado por este motor.

---

## 2. Flujo de Procesamiento

```
TelemetryService (#12) ──publish("telemetry.gps.recorded")──► InMemoryEventDispatcher
                                                                     │ (sin await: no frena el flush de lotes)
                                                                     ▼
                                     GeoDeviationAnalyzer.processTelemetryEvent(payload)
                                       1. parseGpsSample  → descarta payloads malformados
                                       2. cola serial por id_viaje (orden de la ventana)
                                       3. ventana deslizante de las últimas 10 lecturas
                                       4. geometría cacheada (ST_Simplify, TTL 5 min)
                                       5. for rule of TELEMETRY_ANOMALY_RULES → rule.evaluate()
                                                                     │ AnomalyDetection
                                                                     ▼
                                     GeoSecurityIncidentReporter.report()
                                       a. INSERT incidente (CRITICO, coordenada geography)
                                       b. AuditService.logCriticalEvent (cadena SHA-256)
                                       c. Socket.IO 'coordination:route_security_alert' → sala 'coordinacion'
                                       d. publish("geo.security.incident") → Issue #15
```

- **Idempotencia y orden:** lecturas con `id_gps` repetido o `fecha_hora` no posterior a la última del viaje se ignoran (`IGNORED_DUPLICATE_OR_OUT_OF_ORDER`).
- **Aislamiento de fallos:** una excepción en una regla incrementa `ruleErrors` sin detener las demás; un fallo de auditoría, Socket.IO o publicación del evento no revierte el incidente ya persistido.
- **Memoria acotada:** los viajes sin lecturas durante 1 h se retiran del estado del motor y de cada regla (`resetTrip`).

---

## 3. Arquitectura (OCP + DIP)

### OCP — `ITelemetryAnomalyRule`

`GeoDeviationAnalyzer` recibe la colección `TELEMETRY_ANOMALY_RULES` y la recorre sin conocer implementaciones concretas. Añadir un chequeo (p. ej. un futuro `SpeedingDetector`) consiste en crear la clase y registrarla en la factoría `TELEMETRY_ANOMALY_RULES` de `geo-monitoring.module.ts`, sin tocar el flujo de procesamiento. La prueba *"OCP — ejecuta una regla nueva sin modificar el motor"* lo verifica con un detector de exceso de velocidad inyectado.

| Regla | Código | Lógica |
| --- | --- | --- |
| `RouteDeviationDetector` | `DESVIO_RUTA_SIGNIFICATIVO` | Distancia rápida en memoria a la polilínea simplificada → contador de lecturas consecutivas `> 300 m` → al llegar a 3, confirmación exacta con `measureDistanceToRoute` (`ST_DWithin` + `ST_Distance`). Si la confirmación ubica el punto dentro del umbral, el candidato se descarta (falso positivo por simplificación). Una alerta por episodio; se rearma al volver a `≤ 300 m`. |
| `ProlongedStopDetector` | `DETENCION_PROLONGADA` | Una lectura es "inmóvil fuera de parada" si `velocidad_kmh < 3` y no está en ninguna geocerca de `parada`. El inicio del episodio se toma de la racha final de lecturas inmóviles en la ventana de 10 lecturas y se conserva mientras la racha continúe (aunque supere la ventana). Alerta una vez cuando la duración supera estrictamente 300 s. |

### DIP — puertos

- **`IRouteGeometryRepository`** (`ROUTE_GEOMETRY_REPOSITORY`): `loadTripRouteGeometry`, `measureDistanceToRoute`, `recordIncident`. Adaptadores `PostgisRouteGeometryRepository` (`GEO_USE_POSTGIS=true`) e `InMemoryRouteGeometryRepository` (por defecto; siembra el viaje `018e38d9-3f00-7200-a000-000000000301` de `R-01` del vehículo `WKK123`).
- **`IGeoSecurityAlertPort`** (`GEO_SECURITY_ALERT_PORT`): implementado por `CoordinationGeoAlertAdapter`, que reutiliza el servidor Socket.IO del namespace `/asistencia` y la sala `coordinacion` para que Coordinación reciba todas sus alertas por un único canal.

---

## 4. Consultas Espaciales PostGIS

| Operación | SQL (resumen) | Propósito |
| --- | --- | --- |
| Carga de geometría | `ST_AsGeoJSON(ST_Simplify(r.polilinea_oficial::geometry, 0.00005, true))` + `ST_AsGeoJSON(p.radio_geocerca::geometry)` por `parada` | Polilínea simplificada (tolerancia ≈ 5,5 m) y geocercas, cacheadas 5 min por viaje (caché negativo de 30 s para viajes sin ruta). |
| Confirmación de desvío | `ST_Distance(r.polilinea_oficial, punto)` y `ST_DWithin(r.polilinea_oficial, punto, 300)` sobre `geography` | Distancia geodésica exacta contra la polilínea **completa**; `ST_DWithin` aprovecha el índice GiST `idx_ruta_polilinea`. Solo se ejecuta tras 3 lecturas candidatas, no por cada coordenada. |
| Registro del incidente | `INSERT INTO public.incidente (..., coordenada) VALUES (..., ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography) RETURNING id_incidente, fecha_hora` | Persistencia `CRITICO` con coordenada indexada (`idx_incidente_coordenada`). |

Todas las consultas son parametrizadas y los identificadores se validan como UUID antes de llegar a la base de datos.

---

## 5. Umbrales (`domain/geo-monitoring.constants.ts`)

| Constante | Valor | Origen |
| --- | --- | --- |
| `ROUTE_DEVIATION_THRESHOLD_METERS` | `300` (estrictamente mayor) | Issue #13 / RF-15 |
| `ROUTE_DEVIATION_CONFIRMATION_READINGS` | `3` lecturas consecutivas | Mitigación de cañones urbanos (Riesgos #13) |
| `PROLONGED_STOP_SPEED_THRESHOLD_KMH` | `< 3 km/h` | Issue #13 |
| `PROLONGED_STOP_DURATION_THRESHOLD_MS` | `> 5 min` | Issue #13 |
| `GPS_SLIDING_WINDOW_SIZE` | `10` lecturas | Tarea técnica #13 |
| `EVALUATION_BUDGET_MS` | `100 ms` | DoD #13 (se registra `overBudgetEvaluations` y un *warning* si se excede) |
| `ROUTE_GEOMETRY_CACHE_TTL_MS` | `5 min` | Caché de polilínea simplificada |

> **Supuesto documentado:** el umbral preventivo de **150 m** marcado como `[PROPUESTA]` en el SRS no se implementa en esta entrega; todas las detecciones son `CRITICO`. Puede añadirse como una nueva `ITelemetryAnomalyRule` de severidad `ADVERTENCIA` sin modificar el motor.

---

## 6. Decisiones de Seguridad (`OWASP ASVS V1.14`)

- **Registro inviolable:** cada incidente se persiste en `incidente` (sin `DELETE` para `app_user_operations`, `V010`) y se encadena en la bitácora forense SHA-256 de `AuditService` con su contexto (ruta, vehículo, lectura GPS, métricas).
- **Validación de entrada:** `parseGpsSample` rechaza payloads sin identificadores, coordenadas WGS84 fuera de rango, velocidades negativas o fechas inválidas antes de alcanzar las reglas.
- **Sin SQL dinámico:** consultas parametrizadas y validación previa de UUID (`loadTripRouteGeometry`/`measureDistanceToRoute` devuelven `null` ante identificadores no válidos).

---

## 7. Métricas Operativas

`GeoDeviationAnalyzer.getMetrics()` expone: `received`, `evaluated`, `rejectedMalformed`, `ignoredDuplicateOrOutOfOrder`, `withoutRouteGeometry`, `detections`, `incidentsReported`, `ruleErrors`, `reportErrors`, `overBudgetEvaluations`, `maxEvaluationMs`, `avgEvaluationMs` y `trackedTrips`. `invalidateRouteGeometry(idViaje?)` fuerza la recarga de la polilínea tras editar una ruta.

---

## 8. Cómo Probarlo

Pruebas unitarias con secuencias pre-grabadas (recorrido normal, vía alterna a 350 m, deriva de cañón urbano, doble desvío, detención fuera/dentro de parada, semáforo y detención más larga que la ventana) y presupuesto de 1 000 lecturas `< 100 ms`:

```bash
npx jest src/modules/geo-monitoring
```

Integración real contra PostgreSQL 16 + PostGIS 3.4 (migraciones `V001`–`V019` aplicadas, credenciales de `app_user` desde `db/.env`):

```bash
RUN_POSTGIS_TESTS=true DB_USER=app_user DB_PASSWORD=<clave-app_user> npx jest src/modules/geo-monitoring/infrastructure --runInBand
```

Activar el adaptador PostGIS en ejecución: `GEO_USE_POSTGIS=true` en `.env`.

*(Comprobado en esta rama: `npx tsc --noEmit` OK; `npm test` 63 suites aprobadas, 7 suites de integración BD omitidas sin flag, 489 pruebas aprobadas y 19 omitidas; integración real PostgreSQL 16 + PostGIS 3.4 con `app_user` — geo-monitoring, routes y telemetry — 5/5 suites y 58/58 pruebas aprobadas, incluido el criterio de aceptación de extremo a extremo con `ST_DWithin`.)*
