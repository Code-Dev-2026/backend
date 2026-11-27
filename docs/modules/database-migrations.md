# Módulo de Base de Datos y Migraciones (PostgreSQL 16 + PostGIS 3.4)

- **Issue de referencia:** `#2` — *feat(db): setup base de datos PostgreSQL 16 + PostGIS y migraciones DDL V001-V010* (cerrada; comentario oficial: *"Implementada y fusionada en #25"*).
- **Orquestación:** `#1` — *feat(epic): orquestación general y arquitectura del backend*.
- **Fuentes en el repositorio:**
  - `db/docker-compose.yml`, `db/.env.example`, `docker/postgres/00_init_roles_dev.sql`
  - `db/migrations/V001__init_extensions_and_roles.sql` a `db/migrations/V010__security_rls_and_permissions.sql`
  - `db/scripts/verify-migrations.ps1`, `db/scripts/verify-migrations.sh`, `db/scripts/test-validation-queries.sql`

---

## 1. Propósito

Proveer la capa de persistencia relacional y geoespacial de **Camino Seguro** sobre **PostgreSQL 16** con **PostGIS 3.4**, garantizando:

1. **Tipos geoespaciales nativos** `GEOGRAPHY(..., 4326)` con índices `GiST` directos sin casts en tiempo de consulta.
2. **Separación de privilegios (OWASP ASVS V1.14)** mediante 4 roles de base de datos sin contraseñas quemadas en el repositorio.
3. **Inmutabilidad forense WORM** y encadenamiento criptográfico `SHA-256` en `bitacora_auditoria` e `historial_estado_custodia`.
4. **Particionamiento mensual** de `registro_gps` con procedimientos de creación y purga por retención.
5. **Segregación financiera** en el esquema aislado `billing` para asegurar la inmunidad operativa del menor (`RN-05`).

---

## 2. Infraestructura y Roles de Base de Datos

### Servicio Docker (`db/docker-compose.yml`)

- Imagen: `postgis/postgis:16-3.4` (`container_name: camino-seguro-postgres`).
- Puerto por defecto: `${POSTGRES_PORT:-5432}:5432`.
- Base de datos por defecto: `camino_seguro_db`.
- Volúmenes:
  - `postgres_data` (`/var/lib/postgresql/data`).
  - `../docker/postgres/00_init_roles_dev.sql` montado de solo lectura en `/docker-entrypoint-initdb.d/00_init_roles_dev.sql`.
  - `./migrations` montado de solo lectura en `/docker-entrypoint-initdb.d/migrations`.
- Variables definidas en `db/.env.example`: `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `APP_OWNER_ROLE`, `APP_USER_ROLE`, `APP_USER_PASSWORD`, `APP_USER_OPERATIONS_ROLE`, `APP_USER_OPERATIONS_PASSWORD`, `APP_USER_BILLING_ROLE`, `APP_USER_BILLING_PASSWORD`.

### Roles y Privilegios Mínimos (`V001`, `V010` y `00_init_roles_dev.sql`)

| Rol | Login | Propiedad DDL | Acceso `public` | Acceso `billing` | Restricciones clave |
| --- | --- | --- | --- | --- | --- |
| `app_owner` | `NOLOGIN` | Dueño exclusivo de esquemas `public`, `billing`, tablas y secuencias | Total (propietario) | Total (propietario) | Reservado para migraciones DDL; no se usa en runtime |
| `app_user` | `LOGIN` | Ninguna | `USAGE`, secuencias, `SELECT/INSERT/UPDATE/DELETE` en tablas | **Revocado (`REVOKE ALL`)** | `REVOKE UPDATE, DELETE, TRUNCATE` en `bitacora_auditoria` e `historial_estado_custodia` |
| `app_user_operations` | `LOGIN` | Ninguna | `SELECT` en 19 tablas maestras; `SELECT/INSERT/UPDATE` en 10 tablas operativas; `SELECT/INSERT` en `registro_gps` e `historial_estado_custodia` | **Revocado (`REVOKE ALL`)** | Append-only en telemetría y custodia; sin acceso a cartera |
| `app_user_billing` | `LOGIN` | Ninguna | `USAGE` y solo `SELECT` en `estudiante`, `acudiente` y `estudiante_acudiente` | `USAGE`, secuencias y `SELECT/INSERT/UPDATE` en `cartera`, `factura`, `pago` | Sin `DELETE` en facturación ni escritura en operación |

Adicionalmente, `V010` ejecuta `REVOKE CREATE ON SCHEMA public FROM PUBLIC`, `REVOKE ALL ON SCHEMA public FROM PUBLIC` y `REVOKE ALL ON SCHEMA billing FROM PUBLIC`.

> **Nota sobre RLS:** Aunque el archivo se llama `V010__security_rls_and_permissions.sql`, en el alcance de Issue #2 implementa propiedad DDL, revocación pública y permisos por rol; **no** declara políticas `ROW LEVEL SECURITY` (`ENABLE ROW LEVEL SECURITY` / `CREATE POLICY`), las cuales corresponden a la fase de hardening posterior (Sprint 4 / Issue #19).

---

## 3. Catálogo de Migraciones DDL (`V001`–`V010`)

En total, `V001`–`V010` crean **40 tablas base en `public`** (además de la partición `registro_gps_default` y las particiones mensuales `registro_gps_YYYY_MM`) y **3 tablas en `billing`**. *(Nota: el enunciado de las issues #1 y #2 menciona "39 tablas" en `public`; el DDL implementado y `test-validation-queries.sql` verifican 40 tablas al incluir `bitacora_auditoria` de `V008`.)*

| Migración | Subdominio | Tablas creadas | Objetos clave (extensiones, dominios, funciones, triggers, índices) |
| --- | --- | --- | --- |
| `V001__init_extensions_and_roles.sql` | Extensiones, roles y utilidades | 0 | Extensiones `postgis`, `pgcrypto`, `btree_gist`; 4 roles; dominio `formato_cifrado_aes` (`^v[0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$`); funciones `fn_uuid_generate_v7()` y alias `uuid_generate_v7()` (RFC 9562) |
| `V002__identity_and_access.sql` | Identidad, RBAC y perfiles | 13 (`public`) | `colegio`, `empresa_transportadora`, `usuario`, `rol` (semilla de 8 roles), `usuario_rol`, `refresh_token` (`family_id`, `token_hash`), `mfa_secret`, `dispositivo`, `coordinador`, `conductor` (`id_usuario` opcional), `monitora`, `acudiente`, `adulto_autorizado`; índices sobre `documento_blind_index` |
| `V003__students_and_custody_vault.sql` | Expedientes de menores, bóveda y alertas judiciales | 5 (`public`) | `estudiante` (sin foto del menor, `domicilio_punto GEOGRAPHY(Point,4326)` con índice GiST), `estudiante_acudiente`, `estudiante_autorizado` (FK compuesta `fk_autorizado_por_tutor`), `expediente_cifrado`, `alerta_judicial`; trigger `trg_limite_autorizados` (`fn_check_max_tres_autorizados`) |
| `V004__geospatial_routes_and_zones.sql` | Flota, rutas, paradas y zonas | 5 (`public`) | `vehiculo`, `ruta` (`polilinea_oficial GEOGRAPHY(LineString,4326)` + GiST), `parada` (`punto_geografico` Point + `radio_geocerca` Polygon + GiST), `asignacion_ruta` (FKs compuestas de paradas en la misma ruta + índice único parcial `uq_estudiante_asignacion_franja`), `zona_geografica` (`poligono` Polygon + GiST) |
| `V005__trips_and_gps_partitions.sql` | Viajes, exclusiones temporales, ocasionales y GPS | 5 (`public`) + particiones | `viaje` (3 restricciones `EXCLUDE USING gist` con `tstzrange` para conductor, vehículo y monitora), `viaje_estudiante`, `inasistencia`, `pasajero_ocasional` (índice único parcial `uq_pasajero_ocasional_cupo_liberado` + trigger `trg_validar_pasajero_ocasional`), `registro_gps` (`PARTITION BY RANGE (fecha_hora)`), `registro_gps_default`, `sp_crear_particiones_gps(2)` y `sp_purgar_particiones_gps(180)` |
| `V006__attendance_and_custody_lifecycle.sql` | Asistencia, entregas y cadena de custodia | 6 (`public`) | `aval_coordinacion`, `incidente`, `registro_de_asistencia` (`uq_asistencia_viaje_evento`), `entrega` (`chk_entrega_estado_coherente` + FKs compuestas a `estudiante_acudiente` / `estudiante_autorizado`), `acta_custodia`, `historial_estado_custodia`; trigger `trg_encadenar_hash_custodia` y función `fn_verificar_integridad_custodia` |
| `V007__notifications_and_offline_sync.sql` | Notificaciones, comunicados, offline e importación | 5 (`public`) | `tipo_notificacion` (semilla de 9 tipos), `notificacion` (FK compuesta a `estudiante_acudiente`, `idempotency_key`), `comunicado` (`chk_alcance_coherencia`), `sync_operation` (`unq_sync_dispositivo_idempotency`), `importacion_matricula` |
| `V008__forensic_audit_trail.sql` | Bitácora forense WORM | 1 (`public`) | `bitacora_auditoria`; función `fn_bloquear_modificacion_inmutable()` (`SECURITY DEFINER`, `SQLSTATE 55000`); triggers `BEFORE UPDATE OR DELETE` y `BEFORE TRUNCATE` sobre `bitacora_auditoria` y `historial_estado_custodia`; trigger `trg_bitacora_encadenar_hash` y verificador `fn_verificar_integridad_bitacora` |
| `V009__billing_isolated_schema.sql` | Esquema segregado de cartera | 3 (`billing`) | Esquema `billing`; tablas `billing.cartera`, `billing.factura`, `billing.pago` |
| `V010__security_rls_and_permissions.sql` | Propiedad y permisos mínimos | 0 | Propiedad a `app_owner`, revocación a `PUBLIC` y matriz de `GRANT`/`REVOKE` para `app_user`, `app_user_operations` y `app_user_billing` |

### Migraciones posteriores existentes en `db/migrations/` (Sprints 1 y 2)

Los sprints posteriores añadieron las migraciones `V011`–`V016` y scripts de reversión en `db/migrations/undo/`:

- `V011__student_sensitive_fields.sql` (Issue #4 — campos cifrados adicionales en `estudiante`).
- `V012__enrollment_import_ledger.sql` (Issue #5 — ledger de importación masiva; ver nota de discrepancia con `V007` en la documentación del módulo de importación).
- `V013__geo_san_benito_geofence.sql` + `undo/U013__...` (Issue #6).
- `V014__custody_fsm_and_worm_functions.sql` + `undo/U014__...` (Issue #7).
- `V015__atomic_boarding_and_overcapacity.sql` + `undo/U015__...` (Issue #8).
- `V016__atomic_disembark_and_safe_return.sql` + `undo/U016__...` (Issue #9).

---

## 4. Reglas de Negocio e Invariantes en Base de Datos

- **Máximo 3 adultos autorizados activos por menor (`V003`, RF-05):** `trg_limite_autorizados` toma bloqueo pesimista `SELECT 1 FROM estudiante ... FOR UPDATE` y lanza `SQLSTATE 23514` si se intenta superar 3 registros con `activo = TRUE`.
- **Integridad ruta–parada y unicidad de franja (`V004`):** `asignacion_ruta` exige vía FKs compuestas que `id_parada_subida` e `id_parada_bajada` pertenezcan a la misma `id_ruta`, y `uq_estudiante_asignacion_franja` impide doble asignación activa por `(id_estudiante, ciclo_horario)`.
- **Cero doble reserva en viajes (`V005`):** tres restricciones `EXCLUDE USING gist` impiden solapamientos de `tstzrange(hora_inicio_programada, hora_fin_programada)` para el mismo conductor, vehículo o monitora cuando `estado IN ('PROGRAMADO', 'EN_CURSO')`.
- **Pasajero ocasional (`V005`, RN-03 / HU-04):** `trg_validar_pasajero_ocasional` exige radicación con al menos 2 horas de antelación respecto a `hora_inicio_programada` y existencia previa de una `inasistencia` con `cupo_liberado = TRUE` del estudiante liberador.
- **Coherencia de entrega (`V006`, RF-06 / RF-08 / RN-04):** `chk_entrega_estado_coherente` valida correspondencia estricta entre `estado_entrega`, `tipo_receptor`, `id_acudiente` e `id_autorizado`, respaldado por FKs compuestas a `estudiante_acudiente` y `estudiante_autorizado`.
- **Cadena criptográfica WORM (`V006`, `V008`):**
  - `historial_estado_custodia` serializa inserciones con `pg_advisory_xact_lock(9876543211)` y calcula `hash_sha256_actual` con `pgcrypto.digest(..., 'sha256')` encadenado al hash previo (génesis de 64 ceros).
  - `bitacora_auditoria` serializa inserciones con `pg_advisory_xact_lock(9876543210)` y encadena secuencia, tabla, operación, registro, usuario, timestamp UTC, payloads JSON y hash anterior.
  - Ambas tablas bloquean `UPDATE`, `DELETE` y `TRUNCATE` con `SQLSTATE 55000`.
- **Inmunidad operativa frente a mora (`V009`, `V010`, RN-05):** `billing` solo es escribible por `app_user_billing`; ni `app_user` ni `app_user_operations` tienen acceso al esquema `billing`.

---

## 5. Decisiones de Seguridad

1. **Sin credenciales quemadas (`ASVS V1.14`):** `V001` crea los roles sin cláusula `PASSWORD`. En desarrollo local, `docker/postgres/00_init_roles_dev.sql` lee contraseñas en tiempo de inicialización mediante `\getenv` desde las variables del contenedor (`db/.env`).
2. **Validación sintáctica de datos cifrados:** el dominio `formato_cifrado_aes` (`V001`) impide almacenar texto claro accidental en columnas sensibles al exigir el patrón `key_version:iv_b64:tag_b64:ciphertext_b64`.
3. **Mitigación de enumeración (IDOR):** todas las claves primarias utilizan UUIDv7 generado por `fn_uuid_generate_v7()` (RFC 9562), ordenables cronológicamente para preservar rendimiento de índices B-Tree.
4. **Minimización de datos (Ley 1581):** la tabla `estudiante` (`V003`) excluye fotografías de menores; únicamente `expediente_cifrado` (adultos autorizados) y `alerta_judicial` almacenan imágenes cifradas con `formato_cifrado_aes`.
5. **Retención GPS sin bloqueos largos:** `sp_purgar_particiones_gps` aplica `ALTER TABLE registro_gps DETACH PARTITION ... CONCURRENTLY` antes de `DROP TABLE` para particiones mayores a 180 días.

---

## 6. Cómo Ejecutar y Probarlo

### Preparación

1. Copia `db/.env.example` a `db/.env` y define las contraseñas locales.
2. Levanta el contenedor PostgreSQL 16 + PostGIS 3.4:
   ```bash
   cd db
   docker compose up -d
   ```

### Ejecución y validación automatizada

Los scripts aplican en orden todos los archivos `db/migrations/V*.sql` con `-v ON_ERROR_STOP=1` y luego ejecutan `db/scripts/test-validation-queries.sql` dentro de una transacción con `ROLLBACK` final:

- **Windows (PowerShell):**
  ```powershell
  .\db\scripts\verify-migrations.ps1
  ```
  Detecta `psql` en `PATH` o rutas estándar de PostgreSQL 15/16 y, si no existe, hace fallback automático a `docker exec -i camino-seguro-postgres psql`.

- **Linux / macOS / CI (Bash):**
  ```bash
  ./db/scripts/verify-migrations.sh
  ```

### Qué valida `db/scripts/test-validation-queries.sql`

1. Presencia de las 3 extensiones (`postgis`, `pgcrypto`, `btree_gist`).
2. Presencia de los 4 roles (`app_owner`, `app_user`, `app_user_operations`, `app_user_billing`).
3. Existencia de las 3 tablas de `billing` y las 40 tablas de `public`.
4. Particionamiento activo de `registro_gps`.
5. Índice `GiST` en todas las columnas `geography` de `public`.
6. Prueba negativa WORM: inserción en `bitacora_auditoria`, bloqueo de `UPDATE` y `DELETE` con `SQLSTATE 55000` y verificación de cadena con `fn_verificar_integridad_bitacora(100)`.

### Notas operativas y estado de verificación

- **Glob `V*.sql`:** aunque los comentarios de `verify-migrations.ps1` y `verify-migrations.sh` indican *"V001 a V010"*, ambos scripts iteran sobre `V*.sql`, por lo que ejecutan todas las migraciones presentes actualmente (`V001` a `V016`).
- **Verificación en vivo:** *pendiente de verificar* en este entorno (Docker Desktop no estuvo activo y `psql` nativo no está instalado en el host durante la redacción de esta etapa).
