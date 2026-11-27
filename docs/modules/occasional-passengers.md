# Gestión Transaccional de Pasajeros Ocasionales y Reasignación de Cupos (`PassengersModule`)

- **Issue de referencia:** `#11` — *feat(passengers): gestión transaccional de pasajeros ocasionales y reasignación de cupos*.
- **Fuentes en el código:**
  - `src/modules/passengers/` (`passengers.module.ts`, `passengers.controller.ts`, `passenger-capacity-evaluator.service.ts`, `occasional-booking.service.ts`, `domain/occasional-passenger.types.ts`, `domain/occasional-passenger-repository.port.ts`, `dto/occasional-passenger.dto.ts`, `infrastructure/in-memory-occasional-passenger.repository.ts`, `infrastructure/postgres-occasional-passenger.repository.ts`)
  - Configuración de entorno: `src/config/env.validation.ts` (`PASSENGERS_USE_POSTGRES`)
  - Integración reutilizada: `CustodyService` (`src/modules/custody/custody.service.ts`), `AttendanceModule` (`InMemoryAttendanceRepository` / `fn_registrar_abordaje_atomico` en `V015`), `HashService` (`src/common/crypto/hash.service.ts`), `AuditService` (`src/modules/audit/audit.service.ts`)
  - DDL asociado: `db/migrations/V005__trips_and_gps_partitions.sql`, `db/migrations/V015__atomic_boarding_and_overcapacity.sql`, `db/migrations/V018__occasional_passengers_and_seat_reallocation.sql` y `db/migrations/undo/U018__occasional_passengers_and_seat_reallocation.sql`

---

## 1. Propósito

Gestionar de forma transaccional y atómica las solicitudes de pasajeros ocasionales (`pasajero_ocasional`) conforme a `RF-05` y `RN-03`, permitiendo que un acudiente solicite un cupo para su hijo en una ruta distinta únicamente cuando existe una vacante efectiva liberada por inasistencia previa, existe cupo nominal disponible sin sobrecupo y la radicación se realiza con al menos **2 horas de antelación** respecto a `viaje.hora_inicio_programada`. Tras la aprobación de Coordinación, el estudiante queda incluido automáticamente en `viaje_estudiante` como pasajero ocasional.

> **Alcance explícito:** no se admite sobrecupo bajo ninguna excepción. Los criterios del issue `#12` están fuera del alcance de esta implementación.

---

## 2. Arquitectura SRP, Entidades y Tablas

### Separación de Responsabilidades (SRP)

- **`PassengerCapacityEvaluator`** (`src/modules/passengers/passenger-capacity-evaluator.service.ts`): servicio especializado exclusivamente en calcular el balance de vacantes netas del viaje (`calculateVacancyBalance`), evaluar la antelación temporal contra `hora_inicio_programada` (`evaluateLeadTime`, mínimo `2` horas / `120` minutos) y ejecutar la evaluación conjunta sin cortocircuito (`evaluateBookingEligibility`).
- **`OccasionalBookingService`** (`src/modules/passengers/occasional-booking.service.ts`): gestiona el ciclo de vida de la reserva (`requestOccasionalSeat`, `approveOccasionalSeat`, `getTripVacancyBalance`, `revertAbsence`), genera el token provisional y su hash SHA-256 (`HashService.sha256`), registra eventos forenses en `AuditService` y traduce excepciones de dominio a códigos HTTP.
- **Persistencia dual (`OCCASIONAL_PASSENGER_REPOSITORY`):** selecciona `PostgresOccasionalPassengerRepository` cuando `PASSENGERS_USE_POSTGRES=true` e `InMemoryOccasionalPassengerRepository` en caso contrario.

### Tablas y Cambios DDL (`V005`, `V015`, `V018`)

- **Tablas involucradas:** `pasajero_ocasional`, `inasistencia`, `viaje`, `vehiculo`, `asignacion_ruta`, `viaje_estudiante` (más `acudiente`, `estudiante`, `estudiante_acudiente`, `coordinador`, `ruta` para validaciones de autorización e integridad).
- **Base reutilizada de `V005` y `V015`:** tabla `pasajero_ocasional`, índice único parcial `uq_pasajero_ocasional_cupo_liberado (id_viaje, id_estudiante_que_libera_cupo) WHERE estado_solicitud IN ('RADICADA', 'APROBADO_COORDINACION', 'UTILIZADO')`, trigger `trg_validar_pasajero_ocasional` y reconocimiento de `qr_provisional_hash` en `fn_registrar_abordaje_atomico` (`V015`).
- **Cambios en `V018__occasional_passengers_and_seat_reallocation.sql`** *(reversibles mediante `db/migrations/undo/U018__occasional_passengers_and_seat_reallocation.sql`)*:
  1. Agrega las columnas opcionales `solicitado_por_acudiente` (FK a `public.acudiente`) y `motivo` en `public.pasajero_ocasional`, la restricción `chk_pasajero_ocasional_distinto_liberador (id_estudiante <> id_estudiante_que_libera_cupo)`, el índice único parcial `uq_pasajero_ocasional_estudiante_viaje` y el índice `idx_pasajero_ocasional_acudiente`.
  2. Crea el trigger `trg_proteger_inasistencia_cupo_asignado` (`BEFORE UPDATE OR DELETE ON public.inasistencia`) que impide revertir o eliminar una inasistencia si su cupo ya fue asignado a un pasajero ocasional activo (`INASISTENCIA_IRREVERSIBLE_CUPO_ASIGNADO`, `SQLSTATE 23514`).
  3. Crea `fn_evaluar_balance_vacantes_viaje(p_id_viaje)` para calcular `estudiantes_asignados`, `inasistencias_reportadas`, `ocasionales_activos`, `ocupacion_proyectada`, `inasistencias_disponibles`, `cupo_nominal_disponible` y `vacantes_netas`.
  4. Crea `fn_solicitar_pasajero_ocasional(...)` con bloqueo pesimista `FOR UPDATE OF v` sobre `public.viaje`, selección `FOR UPDATE OF i SKIP LOCKED` de una inasistencia disponible, verificación `OWASP ASVS V4.1` de vínculo acudiente-estudiante y evaluación conjunta sin cortocircuito de `RN-03`.
  5. Crea `fn_aprobar_pasajero_ocasional(...)` con orden canónico de bloqueos (`viaje` → `pasajero_ocasional`), verificación del colegio del coordinador, revalidación de inasistencia y aforo nominal, actualización a `APROBADO_COORDINACION` e inserción atómica en `public.viaje_estudiante` (`estado_custodia = 'NO_INICIADO'`, `es_pasajero_ocasional = TRUE`).
  6. Otorga `GRANT EXECUTE` sobre las tres funciones a `app_user` y únicamente sobre `fn_evaluar_balance_vacantes_viaje` a `app_user_operations` (`OWASP ASVS V1.14`).

---

## 3. Endpoints HTTP

Prefijo global `/api/v1` (`PassengersController`, ruta base `pasajeros-ocasionales`):

| Método y Ruta | Roles | Descripción y respuestas clave |
| --- | --- | --- |
| `POST /api/v1/pasajeros-ocasionales/solicitar` | `ACUDIENTE` *(equivalencia `parent`)* | Radica solicitud (`id_viaje`, `id_estudiante`, `motivo?`) validando vínculo acudiente-estudiante, antelación $\ge 2$ h y vacante por inasistencia previa (`201` creada en estado `RADICADA`, `400` DTO inválido, `401` sin JWT, `403` rol no permitido o acudiente no vinculado al menor, `404` viaje/estudiante inexistente, `409` viaje no `PROGRAMADO`, estudiante ya asignado a la ruta o solicitud duplicada, `422` incumplimiento `RN-03`). |
| `POST /api/v1/pasajeros-ocasionales/aprobar` | `COORDINADORA_CONVIVENCIA`, `RECTORIA`, `ADMIN` *(MFA obligatorio)* | Aprueba una solicitud `RADICADA` (`id_pasajero_ocasional`, `id_coordinador?`) e incluye automáticamente al estudiante en `viaje_estudiante` (`200` aprobada en estado `APROBADO_COORDINACION`, `400` DTO inválido, `401` sin JWT o sin MFA, `403` rol sin potestad o coordinador de otro colegio, `404` solicitud inexistente, `409` estado distinto de `RADICADA` o viaje no `PROGRAMADO`, `422` vacante no disponible o sobrecupo). |

---

## 4. Reglas de Negocio, Transacciones y Mitigación de Riesgos

1. **Antelación mínima de 2 horas (`RN-03`):** se calcula en servidor contra `viaje.hora_inicio_programada` (usando el reloj inyectado `PASSENGERS_CLOCK`, por defecto `new Date()`). Si `hora_inicio_programada - solicitado_en < 2 horas` (por ejemplo, solicitud a las 05:00 AM para salida a las 06:30 AM), la solicitud se rechaza con `ANTELACION_INSUFICIENTE`.
2. **Balance de vacantes sin sobrecupo (`RN-03`):**
   - `ocupacion_proyectada = GREATEST(0, estudiantes_asignados - inasistencias_reportadas) + ocasionales_activos`
   - `cupo_nominal_disponible = GREATEST(0, capacidad_nominal - ocupacion_proyectada)`
   - `inasistencias_disponibles = GREATEST(0, inasistencias_reportadas - ocasionales_activos)`
   - `vacantes_netas = LEAST(cupo_nominal_disponible, inasistencias_disponibles)`
   - Si no existe inasistencia liberada disponible o `ocupacion_proyectada >= capacidad_nominal`, se rechaza con `SIN_VACANTE_POR_INASISTENCIA` y/o `CAPACIDAD_NOMINAL_AGOTADA`.
3. **Evaluación conjunta sin cortocircuito:** si una solicitud incumple simultáneamente la antelación mínima y la existencia de vacante (criterio de aceptación del issue `#11`), el error `422` (`REGLAS_PASAJERO_OCASIONAL_INCUMPLIDAS`) reporta **ambos** motivos (`ANTELACION_INSUFICIENTE` y `SIN_VACANTE_POR_INASISTENCIA`).
4. **Atomicidad, concurrencia y rollback:**
   - En PostgreSQL, cada operación corre dentro de una transacción explícita `BEGIN ... COMMIT / ROLLBACK` con `SELECT ... FOR UPDATE OF v` sobre `public.viaje` y `FOR UPDATE OF i SKIP LOCKED` sobre `public.inasistencia`, respaldada por `uq_pasajero_ocasional_cupo_liberado`. En memoria, `InMemoryOccasionalPassengerRepository` serializa por `id_viaje` (`withTripLock`) y revierte el estado a `RADICADA` (eliminando cualquier entrada parcial en `viaje_estudiante`) si ocurre un fallo a mitad de la aprobación.
5. **Inclusión automática e integración con Issues `#7` y `#8`:** al aprobarse, el estudiante se registra en `viaje_estudiante` con `estado_custodia = 'NO_INICIADO'` y `es_pasajero_ocasional = TRUE`, habilitando su abordaje posterior en `POST /api/v1/asistencia/abordaje` con `metodo_validacion = 'QR_OCASIONAL_TEMPORAL'` (`V015`), momento en el que `pasajero_ocasional.estado_solicitud` transiciona a `UTILIZADO`.
6. **Irreversibilidad de inasistencia asignada (mitigación de riesgo):** una vez que el cupo de una inasistencia está vinculado a una solicitud activa (`RADICADA`, `APROBADO_COORDINACION`, `UTILIZADO`), intentar eliminar la inasistencia o marcar `cupo_liberado = FALSE` es rechazado con `INASISTENCIA_IRREVERSIBLE_CUPO_ASIGNADO` (`409 Conflict` / trigger `trg_proteger_inasistencia_cupo_asignado`).

---

## 5. Decisiones de Seguridad

- **Autorización acudiente-estudiante (`OWASP ASVS V4.1`):** el endpoint `/solicitar` toma la identidad exclusivamente del JWT (`@CurrentUser().id_usuario`) y verifica en `acudiente` + `estudiante_acudiente` que el usuario autenticado es acudiente del `id_estudiante` solicitado; de lo contrario retorna `403 Forbidden`.
- **Autorización de Coordinación y MFA:** el endpoint `/aprobar` exige roles de Coordinación (`COORDINADORA_CONVIVENCIA`, `RECTORIA`, `ADMIN`), MFA verificado (`AppMfaGuard`) y pertenencia del coordinador al mismo `id_colegio` de la ruta del viaje (`403 Forbidden` si difiere).
- **Reloj de servidor:** `solicitado_en` nunca se acepta del cuerpo HTTP; se determina en el servidor para evitar manipulación de la regla de 2 horas.
- **Auditoría forense:** cada radicación y aprobación se encadena en `AuditService` (`PASAJERO_OCASIONAL_SOLICITADO`, `PASAJERO_OCASIONAL_APROBADO`).

---

## 6. Cómo Probarlo

Pruebas unitarias, de concurrencia, rollback y HTTP + RBAC + MFA del Issue `#11`:

```bash
npx jest src/modules/passengers/passenger-capacity-evaluator.service.spec.ts src/modules/passengers/occasional-booking.service.spec.ts src/modules/passengers/passengers.http.spec.ts
```

Suite completa del repositorio (incluyendo regresión de Issues `#1`–`#10`):

```bash
npm test
```

Compilación TypeScript (`build`):

```bash
npm run build
```

Pruebas de integración reales contra PostgreSQL 16 + PostGIS 3.4 (`V013`–`V018`, requiere contenedor `camino-seguro-postgres` con `V018` aplicada, `RUN_POSTGRES_TESTS=true`, `RUN_POSTGIS_TESTS=true` y variables de conexión locales `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`):

```bash
npx jest src/modules/passengers/infrastructure/postgres-occasional-passenger.repository.integration.spec.ts src/modules/attendance/infrastructure/postgres-attendance.repository.integration.spec.ts src/modules/attendance/infrastructure/postgres-disembark.repository.integration.spec.ts src/modules/custody/infrastructure/postgres-custody.repository.integration.spec.ts src/modules/custody/judicial-alerts/infrastructure/postgres-judicial-alert.repository.integration.spec.ts src/modules/routes/infrastructure/postgis-geo.repository.integration.spec.ts --runInBand
```

*(Comprobado en esta rama: `npm run build` OK (`exit 0`); `npm test` 58 suites aprobadas, 6 suites de integración BD omitidas sin flag activo, 427 pruebas aprobadas y 15 omitidas; integración real contra PostgreSQL 16 + PostGIS 3.4 con `app_user` 6/6 suites y 15/15 pruebas aprobadas; ciclo reversible `V018` UP → `U018` DOWN → `V018` UP ejecutado sin errores sobre `camino-seguro-postgres`; `npm run lint` continúa fallando por ausencia preexistente de archivo de configuración `.eslintrc.*` en el repositorio.)*
