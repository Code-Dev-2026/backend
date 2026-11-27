# Ingesta de Telemetría IoT Vehicular vía MQTT y Almacenamiento Particionado (`TelemetryModule`)

- **Issue de referencia:** `#12` — *feat(telemetry): ingesta de telemetría IoT vehicular vía broker MQTT y almacenamiento particionado* (Milestone: *Sprint 3: Tiempo real y notificaciones*).
- **Fuentes en el código:**
  - `src/modules/telemetry/` (`telemetry.module.ts`, `telemetry.controller.ts`, `telemetry.service.ts`, `telemetry-packet.validator.ts`, `telemetry-partition-maintenance.job.ts`, `domain/telemetry.types.ts`, `domain/telemetry-ingest.port.ts`, `domain/telemetry-repository.port.ts`, `dto/telemetry-gps.dto.ts`, `infrastructure/telemetry-ingest.channel.ts`, `infrastructure/in-memory-event-dispatcher.ts`, `infrastructure/in-memory-telemetry.repository.ts`, `infrastructure/postgres-telemetry.repository.ts`, `infrastructure/mqtt-telemetry.subscriber.ts`)
  - Puertos reutilizados: `IEventDispatcherPort` (`src/common/ports/event-dispatcher.port.ts`)
  - Configuración de entorno: `src/config/env.validation.ts`, `.env.example`, `db/.env.example`
  - Infraestructura MQTT TLS/mTLS: `db/docker-compose.yml` (servicio `mosquitto`, perfil `mqtt`), `docker/mosquitto/mosquitto.conf`, `docker/mosquitto/acl.conf`, `docker/mosquitto/generate-dev-certs.ps1`, `docker/mosquitto/generate-dev-certs.sh`
  - DDL asociado: `db/migrations/V004__geospatial_routes_and_zones.sql`, `db/migrations/V005__trips_and_gps_partitions.sql`, `db/migrations/V010__security_rls_and_permissions.sql`, `db/migrations/V019__telemetry_gps_ingestion_and_partitions.sql` y `db/migrations/undo/U019__telemetry_gps_ingestion_and_partitions.sql`

---

## 1. Propósito

Ingerir telemetría GPS continua emitida por los vehículos escolares a través del broker MQTT sobre TLS/mTLS (`telemetry/vehicles/+/gps`) o mediante el endpoint HTTPS fallback (`POST /api/v1/telemetria/gps`), validando cada paquete telemático, descartando lecturas con baja precisión GPS (`> 30 m`), almacenando en lote en la tabla particionada mensualmente `public.registro_gps`, manteniendo las particiones con retención de **180 días** y entregando cada punto persistido al bus de eventos en memoria en `< 500 ms` (`RF-10`, `RNF-05`).

> **Alcance explícito:** no incluye calibración de hardware vehicular en campo ni funcionalidades de los issues `#13` en adelante (desvíos, zonas sombra, WebSockets o notificaciones push derivadas de telemetría).

---

## 2. Arquitectura Hexagonal (DIP), Particionamiento y Tablas

### Inversión de Dependencias (DIP)

- **`ITelemetryIngestPort`** (`src/modules/telemetry/domain/telemetry-ingest.port.ts`, implementado por `TelemetryIngestChannel`): desacopla `TelemetryService` de la fuente de entrada. Tanto `MqttTelemetrySubscriber` (`source: "MQTT"`), como `TelemetryController` (`source: "HTTP_FALLBACK"`) y cualquier simulador de pruebas (`source: "SIMULATOR"`) publican sobres `RawTelemetryEnvelope` en `ITelemetryIngestPort` sin alterar el procesador.
- **`TelemetryPacketValidator`** (`src/modules/telemetry/telemetry-packet.validator.ts`): valida tamaño de payload (`<= 8192 bytes`), JSON válido, coherencia entre tópico MQTT y placa vehicular, coordenadas WGS84, velocidad (`0–250 km/h`), rumbo (`[0, 360)`), odómetro (`>= 0`), marca temporal ISO-8601 (máximo 5 min hacia el futuro) y descarte de precisión GPS `> 30 m`.
- **`TelemetryService`** (`src/modules/telemetry/telemetry.service.ts`): agrupa paquetes validados en un buffer configurable (`TELEMETRY_BATCH_SIZE`, `TELEMETRY_BATCH_FLUSH_MS`), persiste mediante `ITelemetryRepository.insertBatch` y despacha eventos `telemetry.gps.recorded` hacia `IEventDispatcherPort` (`InMemoryEventDispatcher`).
- **`TelemetryPartitionMaintenanceJob`** (`src/modules/telemetry/telemetry-partition-maintenance.job.ts`): ejecuta `ensureMonthlyPartitions` (`fn_crear_particion_gps_mensual`) y `purgeExpiredPartitions` (`fn_purgar_particiones_gps_vencidas` con retención de 180 días). Desactivado por defecto salvo `TELEMETRY_PARTITION_JOB_ENABLED=true`.
- **Persistencia dual (`TELEMETRY_USE_POSTGRES`):** selecciona `PostgresTelemetryRepository` cuando `TELEMETRY_USE_POSTGRES=true` e `InMemoryTelemetryRepository` en caso contrario.

### Tablas y Estrategia de Particionamiento (`V005` + `V019` / `U019`)

- **Tablas involucradas:** `public.vehiculo` (`V004`), `public.viaje` (`V005`) y `public.registro_gps` (`V005`, particionada con `PARTITION BY RANGE (fecha_hora)` y particiones `registro_gps_YYYY_MM` + `registro_gps_default`). *(Nota: aunque el enunciado del issue `#12` referencia `V007`, en el DDL real `registro_gps` fue creada en `V005__trips_and_gps_partitions.sql` y reutilizada sin duplicación.)*
- **Inserción batch optimizada (`PostgresTelemetryRepository.insertBatch`):** ejecuta un único `INSERT INTO public.registro_gps (...) SELECT ... FROM unnest(...) ON CONFLICT (id_vehiculo, fecha_hora) DO NOTHING RETURNING id_gps, id_vehiculo, fecha_hora, tableoid::regclass::text AS partition_name` con geometría nativa PostGIS `ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography`, garantizando alto rendimiento, deduplicación atómica y trazabilidad exacta de la partición física destino.
- **Cambios reversibles en `V019__telemetry_gps_ingestion_and_partitions.sql`** *(revertibles con `db/migrations/undo/U019__telemetry_gps_ingestion_and_partitions.sql`)*:
  1. Añade las columnas opcionales `precision_metros NUMERIC(6,2)` y `odometro_km NUMERIC(10,2)` en `public.registro_gps` y restricciones `CHECK` (`precision_metros <= 30`, `odometro_km >= 0`, `velocidad_kmh` en `0..250`, `rumbo_grados` en `[0, 360)`).
  2. Crea el índice único particionado `uq_registro_gps_vehiculo_fecha (id_vehiculo, fecha_hora)` para deduplicación idempotente e índice `idx_gps_vehiculo_tiempo (id_vehiculo, fecha_hora DESC)`.
  3. Crea `public.fn_crear_particion_gps_mensual(p_fecha_referencia TIMESTAMPTZ DEFAULT NOW(), p_meses_adelante INT DEFAULT 2)` (`SECURITY DEFINER SET search_path = public, pg_temp`) que crea las particiones `registro_gps_YYYY_MM`, asigna propietario `app_owner` y concede `SELECT, INSERT` a `app_user` y `app_user_operations`.
  4. Crea `public.fn_purgar_particiones_gps_vencidas(p_dias_retencion INT DEFAULT 180, p_fecha_referencia TIMESTAMPTZ DEFAULT NOW())` (`SECURITY DEFINER SET search_path = public, pg_temp`) que desacopla (`DETACH PARTITION`) y elimina únicamente particiones cuyo mes completo expiró respecto a la ventana de retención.
  5. Otorga `GRANT EXECUTE` sobre `fn_crear_particion_gps_mensual` a `app_user` y `app_user_operations`, y sobre `fn_purgar_particiones_gps_vencidas` únicamente a `app_user` (`OWASP ASVS V1.14`).

---

## 3. Infraestructura Broker MQTT (Eclipse Mosquitto 2.0 mTLS + ACL)

El servicio `mosquitto` está definido bajo el perfil `mqtt` en `db/docker-compose.yml` con configuración en `docker/mosquitto/mosquitto.conf` y política ACL en `docker/mosquitto/acl.conf`. Los certificados y el archivo `docker/mosquitto/passwd` se generan localmente y están excluidos en `.gitignore`.

### Levantamiento desde cero (desarrollo local)

1. Define las contraseñas de desarrollo en variables de entorno (sin escribir secretos en Git) y genera la CA local, certificados mTLS (servidor, `backend_telemetry`, vehículo `WKK123`) y `docker/mosquitto/passwd`:

   - **Windows (PowerShell):**
     ```powershell
     $env:MQTT_BACKEND_PASSWORD = "<definir-clave-local-backend>"
     $env:MQTT_VEHICLE_WKK123_PASSWORD = "<definir-clave-local-vehiculo>"
     .\docker\mosquitto\generate-dev-certs.ps1
     ```
   - **Linux / macOS (Bash):**
     ```bash
     export MQTT_BACKEND_PASSWORD="<definir-clave-local-backend>"
     export MQTT_VEHICLE_WKK123_PASSWORD="<definir-clave-local-vehiculo>"
     ./docker/mosquitto/generate-dev-certs.sh
     ```

2. Levanta PostgreSQL y Mosquitto desde la carpeta `db/` (asegurándote de que `db/.env` exista a partir de `db/.env.example` y que no exista otro contenedor previo con el nombre `camino-seguro-mosquitto`):

   ```bash
   cd db
   docker compose --profile mqtt up -d
   ```

3. Configura en `.env` (copiado desde `.env.example`) las variables del cliente MQTT (`MQTT_ENABLED=true`, `MQTT_BROKER_URL=mqtts://localhost:8883`, `MQTT_USERNAME=backend_telemetry`, `MQTT_PASSWORD`, `MQTT_TLS_CA_PATH`, `MQTT_TLS_CERT_PATH`, `MQTT_TLS_KEY_PATH`).

---

## 4. Endpoint REST Fallback (`POST /api/v1/telemetria/gps`)

Prefijo global `/api/v1` (`TelemetryController`, ruta base `telemetria`):

| Método y Ruta | Roles | Descripción y respuestas clave |
| --- | --- | --- |
| `POST /api/v1/telemetria/gps` | `CONDUCTOR`, `MONITORA`, `JEFE_OPERACIONES`, `GERENCIA_TRANSPORTE`, `ADMIN` | Ingesta HTTPS fallback ante pérdida de conectividad MQTT (`placa?`, `id_vehiculo?`, `id_viaje?`, `latitud`, `longitud`, `velocidad_kmh`, `precision_metros`, `rumbo_grados`, `odometro_km`, `precision_hdop?`, `bateria_respaldo_activa?`, `timestamp`). Respuestas: `200` (`STORED`, `DISCARDED_LOW_ACCURACY` si `precision_metros > 30`, o `DUPLICATE_IGNORED`), `400` (payload/DTO inválido o sin identificador vehicular), `401` (sin JWT), `403` (rol no operativo como `ACUDIENTE`), `404` (vehículo inactivo/no registrado o sin viaje operativo). |

---

## 5. Reglas de Validación, Deduplicación y Rendimiento

1. **Descarte por baja precisión GPS (`> 30 m`):** paquetes con `precision_metros > TELEMETRY_MAX_ACCURACY_METERS` (`30` por defecto) retornan `DISCARDED_LOW_ACCURACY`, no se escriben en `registro_gps` y no se despachan al bus de eventos.
2. **Deduplicación idempotente:** reintentos QoS 1 de MQTT o reenvíos HTTP con el mismo `(id_vehiculo, fecha_hora)` se absorben con `ON CONFLICT (id_vehiculo, fecha_hora) DO NOTHING` (y mapa por partición en memoria), retornando `DUPLICATE_IGNORED` sin duplicar eventos en `IEventDispatcherPort`.
3. **Reconexión automática MQTT:** `MqttTelemetrySubscriber` configura `reconnectPeriod` (`MQTT_RECONNECT_PERIOD_MS`), registra métricas de `offline` / `reconnect` / `error` y re-suscribe automáticamente a `telemetry/vehicles/+/gps` (`qos: 1`) en cada evento `connect`.
4. **Rendimiento y latencia (`RNF-05`):** el batching (`TELEMETRY_BATCH_SIZE=100`, `TELEMETRY_BATCH_FLUSH_MS=100`) y la inserción `UNNEST` procesan 1,000 puntos (10 vehículos cada 3 s durante 5 minutos) sin pérdida de paquetes y con latencia de almacenamiento + despacho `< 500 ms`.

---

## 6. Decisiones de Seguridad (`OWASP ASVS V10.3` y `V1.14`)

- **Transporte mTLS estricto (`mosquitto.conf` y `MqttTelemetrySubscriber`):** Mosquitto deshabilita acceso anónimo (`allow_anonymous false`), exige TLS ≥ 1.2 con certificado cliente (`require_certificate true`) y valida credenciales (`password_file`). En `NODE_ENV=production`, `MqttTelemetrySubscriber` rechaza al arranque URLs sin cifrar (`mqtt://`), `MQTT_TLS_REJECT_UNAUTHORIZED=false` o ausencia de `MQTT_TLS_CA_PATH`, `MQTT_TLS_CERT_PATH` y `MQTT_TLS_KEY_PATH`.
- **Aislamiento de tópicos por vehículo (ACL + verificación en código):** `docker/mosquitto/acl.conf` restringe cada vehículo a `pattern write telemetry/vehicles/%u/gps` y al backend a `topic read telemetry/vehicles/+/gps`. Adicionalmente, `TelemetryPacketValidator` rechaza con `TOPIC_VEHICLE_MISMATCH` cualquier paquete cuya `placa` difiera del vehículo autenticado en el tópico.
- **Sin secretos en el código:** credenciales del broker y rutas de certificados provienen únicamente de variables de entorno (`ConfigService` / Joi).
- **Privilegios mínimos en BD (`ASVS V1.14`):** `app_user` y `app_user_operations` no reciben permisos DDL generales; la creación y purga de particiones se encapsulan en funciones `SECURITY DEFINER` con `SET search_path = public, pg_temp`.

---

## 7. Cómo Probarlo

Pruebas unitarias, de validación, reconexión MQTT, carga (1,000 puntos) y HTTP + RBAC del Issue `#12`:

```bash
npx jest src/modules/telemetry/telemetry-packet.validator.spec.ts src/modules/telemetry/telemetry.service.spec.ts src/modules/telemetry/infrastructure/mqtt-telemetry.subscriber.spec.ts src/modules/telemetry/telemetry.http.spec.ts
```

Suite completa del repositorio (incluyendo regresión de Issues `#1`–`#11`):

```bash
npm test
```

Compilación TypeScript (`build`):

```bash
npm run build
```

Integración real contra PostgreSQL 16 + PostGIS 3.4 (`V019` aplicada en `camino-seguro-postgres`, `RUN_POSTGRES_TESTS=true` y `RUN_POSTGIS_TESTS=true`, con credenciales desde `db/.env`):

```bash
npx jest src/modules/telemetry/infrastructure/postgres-telemetry.repository.integration.spec.ts src/modules/passengers/infrastructure/postgres-occasional-passenger.repository.integration.spec.ts src/modules/attendance/infrastructure/postgres-attendance.repository.integration.spec.ts src/modules/attendance/infrastructure/postgres-disembark.repository.integration.spec.ts src/modules/custody/infrastructure/postgres-custody.repository.integration.spec.ts src/modules/custody/judicial-alerts/infrastructure/postgres-judicial-alert.repository.integration.spec.ts src/modules/routes/infrastructure/postgis-geo.repository.integration.spec.ts --runInBand
```

*(Comprobado en esta rama: `npm run build` OK (`exit 0`); `npm test` 61 suites aprobadas, 7 suites de integración BD omitidas sin flag activo, 444 pruebas aprobadas y 19 omitidas; integración real PostgreSQL 16 + PostGIS 3.4 con `app_user` 7/7 suites y 19/19 pruebas aprobadas incluyendo inserción en lote de 1,000 puntos y purga > 180 días; ciclo reversible `V019` UP → `U019` DOWN → `V019` UP y `db/scripts/test-validation-queries.sql` ejecutados sin errores en `camino-seguro-postgres`; broker Eclipse Mosquitto 2.0 verificado en vivo rechazando conexión sin certificado cliente mTLS, entregando `telemetry/vehicles/WKK123/gps` en 4 ms y bloqueando `telemetry/vehicles/OTRO99/gps` vía ACL; `npm run lint` falla por ausencia preexistente de archivo `.eslintrc.*` en el repositorio.)*
