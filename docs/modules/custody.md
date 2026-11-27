# Módulo de Custodia Física: Máquina de Estados (FSM) y Persistencia WORM (`CustodyModule`)

- **Issue de referencia:** `#7` — *feat(custody): ciclo de custodia física, máquina de estados FSM y persistencia WORM* (cerrada).
- **Fuentes en el código:**
  - `src/modules/custody/` (`custody.module.ts`, `custody.controller.ts`, `custody.service.ts`, `custody-transition-validator.service.ts`, `morning-custody-init.job.ts`, `domain/*`, `dto/custody.dto.ts`, `infrastructure/postgres-custody.repository.ts`, `infrastructure/in-memory-custody.repository.ts`)
  - `src/common/ports/custody-fsm.port.ts`, `src/common/enums/custody-state.enum.ts`
  - Integración de cierre de viaje: `src/modules/trips/trips.controller.ts`, `src/modules/trips/trips.service.ts`
  - DDL asociado: `db/migrations/V006__attendance_and_custody_lifecycle.sql`, `V008__forensic_audit_trail.sql`, `db/migrations/V014__custody_fsm_and_worm_functions.sql` y `db/migrations/undo/U014__custody_fsm_and_worm_functions.sql`

---

## 1. Propósito

Gobernar el ciclo de vida físico del estudiante durante cada recorrido escolar mediante una **Máquina de Estados Finitos (FSM) unidireccional**, diferenciar las transiciones válidas entre recorrido de **Mañana (`MANANA`)** y **Tarde (`TARDE`)**, garantizar la **inmutabilidad criptográfica WORM (SHA-256)** de cada evento en `historial_estado_custodia`, ejecutar la inicialización diaria idempotente y bloquear el cierre de viajes mientras existan menores a bordo.

---

## 2. Estados FSM, Entidades y Tablas

### Matriz de Transiciones Permitidas (`CustodyStateMachine` / `V014`)

Los 6 estados oficiales (`FsmCustodyState`) y las 6 aristas concretas (`ICustodyTransition`, principio **LSP**) son estrictamente unidireccionales:

| Estado origen | Estado destino | Recorrido(s) | Disparador por defecto | Efecto en timestamps |
| --- | --- | --- | --- | --- |
| `NO_INICIADO` | `EN_ESPERA_ABORDAJE` | `MANANA`, `TARDE` | `INICIO_ESPERA_ABORDAJE` | — |
| `EN_ESPERA_ABORDAJE` | `A_BORDO_VEHICULO` | `MANANA`, `TARDE` | `ABORDAJE_VEHICULO` | Fija `hora_abordaje` |
| `A_BORDO_VEHICULO` | `EN_COLEGIO` | Solo `MANANA` | `LLEGADA_COLEGIO` | Fija `hora_desembarque` |
| `A_BORDO_VEHICULO` | `ENTREGADO_ACUDIENTE` | Solo `TARDE` | `ENTREGA_ACUDIENTE` | Fija `hora_desembarque` |
| `A_BORDO_VEHICULO` | `RETORNO_SEDE_POR_FALLA_ENTREGA` | Solo `TARDE` | `FALLA_ENTREGA_RETORNO_SEDE` | — |
| `RETORNO_SEDE_POR_FALLA_ENTREGA` | `EN_COLEGIO` | Solo `TARDE` | `RECEPCION_SEDE_POR_RETORNO` | Fija `hora_desembarque` |

Estados terminales: `EN_COLEGIO` (en ambos recorridos) y `ENTREGADO_ACUDIENTE` (en `TARDE`). Cualquier transición fuera de esta matriz lanza `CustodyInvariantViolationError` (`422 Unprocessable Entity` con código `CUSTODY_FSM_INVARIANT_VIOLATION` y lista `destinos_permitidos`).

### Tablas y Funciones PostgreSQL (`V006`, `V008`, `V014`)

- **`viaje_estudiante`:** `V014` alinea el `CHECK` de `estado_custodia` a los 6 estados oficiales y define `DEFAULT 'NO_INICIADO'`.
- **`historial_estado_custodia`:** append-only protegida por triggers WORM (`V008`, `SQLSTATE 55000` ante `UPDATE`/`DELETE`/`TRUNCATE`) y encadenada por `trg_encadenar_hash_custodia` (`V006`, `pg_advisory_xact_lock(9876543211)`, génesis de 64 ceros).
- **Funciones almacenadas en `V014`:**
  - `fn_validar_transicion_custodia(origen, destino, tipo_recorrido)` (`IMMUTABLE`).
  - `fn_registrar_transicion_custodia(...)`: bloqueo `FOR UPDATE` en `viaje_estudiante`, valida FSM, actualiza estado/timestamps e inserta en `historial_estado_custodia` devolviendo `secuencia`, `hash_sha256_anterior` y `hash_sha256_actual`.
  - `fn_inicializar_custodia_matutina(p_fecha)`: inserta de forma idempotente (`ON CONFLICT DO NOTHING`) registros `NO_INICIADO` para estudiantes activos con asignación en viajes `PROGRAMADO`/`EN_CURSO` de esa fecha.
  - Trigger `trg_bloquear_cierre_viaje_con_menores_a_bordo` sobre `viaje`: bloquea `UPDATE estado = 'FINALIZADO'` con `SQLSTATE 23514` si hay menores en `A_BORDO_VEHICULO` *(ampliado en `V016` para incluir también `RETORNO_SEDE_POR_FALLA_ENTREGA`)*.
- **Persistencia (`CustodyModule`):** `CUSTODY_USE_POSTGRES=true` → `PostgresCustodyRepository`; `false` (default) → `InMemoryCustodyRepository` (reproduce encadenamiento SHA-256 y verificación WORM en memoria).

---

## 3. Endpoints HTTP

### `CustodyController` (prefijo `/api/v1/custody`)

- **Roles operadores (`CUSTODY_OPERATOR_ROLES`):** `ADMIN`, `COORDINADORA_CONVIVENCIA`, `JEFE_OPERACIONES`, `MONITORA`.
- **Roles administrativos (`CUSTODY_ADMIN_ROLES`):** `ADMIN`, `COORDINADORA_CONVIVENCIA`, `RECTORIA`, `JEFE_OPERACIONES`.
- **Roles de lectura (`CUSTODY_READ_ROLES`):** administrativos + `GERENCIA_TRANSPORTE`, `MONITORA`, `CONDUCTOR`.

| Método y Ruta | Roles | Descripción y respuestas clave |
| --- | --- | --- |
| `POST /api/v1/custody/transitions` | Operadores | Ejecuta transición FSM + inserción WORM (`201`, `400` coordenadas, `404` no matriculado, `422` violación FSM). |
| `POST /api/v1/custody/trips/:tripId/enroll` | Admin | Registra estudiante en `viaje_estudiante` en estado `NO_INICIADO` (`201`). |
| `GET /api/v1/custody/trips/:tripId/students` | Lectura | Lista estados de custodia de todos los estudiantes del viaje. |
| `GET /api/v1/custody/trips/:tripId/students/:studentId` | Lectura | Estado actual + `transiciones_permitidas_manana` y `transiciones_permitidas_tarde` (`200`, `404`). |
| `GET /api/v1/custody/trips/:tripId/history` | Lectura | Historial WORM encadenado SHA-256 de un viaje. |
| `GET /api/v1/custody/students/:studentId/history` | Lectura | Historial WORM de un estudiante (`?limite=`, `1`–`1000`, default `100`). |
| `GET /api/v1/custody/integrity/verify` | Admin | Verifica la cadena SHA-256 completa vía `fn_verificar_integridad_custodia` (`?limite=`, `1`–`50000`, default `10000`). |
| `POST /api/v1/custody/jobs/morning-init` | Admin | Dispara manualmente el job matutino idempotente (`fecha` opcional `YYYY-MM-DD`, `200`). |

> **Endpoints heredados aún activos en `CustodyController`:** `POST /api/v1/custody/verify-receptor` y `POST /api/v1/custody/failed-delivery` permanecen expuestos como placeholders de compatibilidad con respuestas fijas; el flujo real de validación de receptores y retorno a sede se encuentra en `/api/v1/asistencia/descenso` (ver [delivery-recipients.md](delivery-recipients.md)).

### Integración con cierre de viaje (`TripsController`)

- `PATCH /api/v1/trips/:id/finish` invoca `CustodyService.assertTripCanFinalize(id)` y responde `409 Conflict` (`TRIP_CLOSURE_BLOCKED_STUDENTS_ON_BOARD`, con `estudiantes_a_bordo` y `total_a_bordo`) si existen estudiantes en `A_BORDO_VEHICULO` o `RETORNO_SEDE_POR_FALLA_ENTREGA`.

---

## 4. Reglas de Negocio

- **Coordenadas opcionales pero emparejadas:** `CustodyTransitionValidatorService` permite omitir coordenadas GPS, pero si se envía `latitud` debe enviarse `longitud` (y viceversa) dentro de rangos WGS84 `[-90, 90]` y `[-180, 180]`.
- **Job de inicialización matutina (`MorningCustodyInitJob`):** se programa con `setInterval` nativo (`unref()` para no bloquear apagado) solo si `CUSTODY_MORNING_JOB_ENABLED=true`. Evalúa `CUSTODY_MORNING_JOB_HOUR` (default `5`), `CUSTODY_MORNING_JOB_MINUTE` (default `0`) y `CUSTODY_MORNING_JOB_INTERVAL_MS` (default `60000`), garantizando una única ejecución por fecha (`lastExecutedDate`).
- **Puerto hexagonal `ICustodyFsmPort`:** `CustodyService` exporta `CUSTODY_FSM_PORT` (`canTransition` y `transition`) consumible por otros módulos sin acoplarse al repositorio.

---

## 5. Decisiones de Seguridad

- **Inmutabilidad WORM (`OWASP ASVS V1.14`):** protegida simultáneamente por privilegios SQL (`V010`), triggers `BEFORE UPDATE OR DELETE` / `BEFORE TRUNCATE` (`V008`) y verificación forense auditable en `GET /api/v1/custody/integrity/verify`.
- **Serialización sin bifurcaciones:** bloqueo pesimista `FOR UPDATE` sobre `viaje_estudiante` en `fn_registrar_transicion_custodia` y candado consultivo `pg_advisory_xact_lock(9876543211)` al encadenar hashes.
- **Privilegios mínimos de ejecución (`V014`):** `GRANT EXECUTE` explícito sobre las 4 funciones de custodia a `app_user` y `app_user_operations`.

---

## 6. Cómo Probarlo

```bash
npx jest src/modules/custody
```

*(Comprobado: 3 suites aprobadas —`custody-state-machine.spec.ts` con matriz exhaustiva de transiciones válidas e inválidas, `custody.service.spec.ts` y `custody.http.spec.ts`—, 1 suite omitida —`postgres-custody.repository.integration.spec.ts`, requiere PostgreSQL activo—; 100 pruebas aprobadas, 3 omitidas.)*
