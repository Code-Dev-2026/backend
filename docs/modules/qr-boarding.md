# Módulo de Abordaje QR Atómico y Control de Sobrecupo (`AttendanceModule`)

- **Issue de referencia:** `#8` — *feat(attendance): control atómico de abordaje QR y prevención concurrente de sobrecupo* (cerrada).
- **Fuentes en el código:**
  - `src/modules/attendance/` (`attendance.module.ts`, `attendance.controller.ts`, `attendance.service.ts`, `qr-token-validator.service.ts`, `capacity-enforcer.service.ts`, `incident-logger.service.ts`, `boarding-notification-queue.service.ts`, `domain/attendance*.ts`, `dto/register-boarding.dto.ts`, `infrastructure/attendance-realtime.gateway.ts`, `infrastructure/postgres-attendance.repository.ts`, `infrastructure/in-memory-attendance.repository.ts`)
  - DDL asociado: `db/migrations/V005__trips_and_gps_partitions.sql`, `V006__attendance_and_custody_lifecycle.sql`, `db/migrations/V015__atomic_boarding_and_overcapacity.sql` y `db/migrations/undo/U015__atomic_boarding_and_overcapacity.sql`

---

## 1. Propósito

Registrar el abordaje de estudiantes mediante escaneo de código QR (estático institucional, ocasional temporal o dinámico firmado con HMAC-SHA256) con **serialización atómica anti-sobrecupo (`RN-02`)**, rechazo de doble escaneo (`RN-05`), sincronización automática de la FSM de custodia WORM (Issue `#7`), registro automático de incidentes, emisión de eventos en tiempo real vía **Socket.IO** y encolamiento no bloqueante de notificaciones push al acudiente titular.

---

## 2. Entidades, Servicios SRP y Tablas

### Arquitectura SRP (`AttendanceModule`)

| Componente | Responsabilidad única |
| --- | --- |
| `QrTokenValidator` | Valida formato, firma HMAC-SHA256 (tiempo constante) y expiración de QR dinámicos (`cs-qr:v1:<uuid>:<exp>:<sig>`), o calcula `SHA-256` para QR estáticos/ocasionales. |
| `CapacityEnforcer` | Verifica invariantes de aforo (`total_a_bordo < capacidad_nominal`, `RN-02`). |
| `AttendanceService` | Orquesta validación QR, ejecución atómica en repositorio, `IncidentLogger`, `AttendanceRealtimeGateway` y `BoardingNotificationQueueService`. |
| `IncidentLogger` | Persiste anomalías (`INTENTO_SOBRECUPO`, `DOBLE_ABORDAJE_DETECTADO`), registra en `AuditService` y dispara alertas WebSocket a Coordinación. |
| `BoardingNotificationQueueService` | Cola ligera idempotente en memoria que despacha notificaciones push fuera del camino crítico (`< 200 ms`). |
| `AttendanceRealtimeGateway` | Pasarela Socket.IO en namespace `/asistencia` (salas `viaje:<id_viaje>` y `coordinacion`). |

### Tablas y Función PostgreSQL (`V005`, `V006`, `V015`)

- **Tablas involucradas:** `viaje` (`total_a_bordo`), `vehiculo` (`capacidad_nominal`), `registro_de_asistencia` (`uq_asistencia_viaje_evento` + columna `idempotency_key` e índice único parcial `uq_asistencia_idempotency_key` añadidos en `V015`), `viaje_estudiante`, `historial_estado_custodia`, `incidente`, `notificacion`, `estudiante` (`qr_token_hash`), `pasajero_ocasional` (`qr_provisional_hash`).
- **Función almacenada (`V015`):** `fn_registrar_abordaje_atomico(...)` ejecuta `SELECT ... FROM viaje ... FOR UPDATE`, comprueba viaje `EN_CURSO`, resuelve el estudiante por QR/asignación a ruta, detecta idempotencia o doble abordaje, incrementa atómicamente `UPDATE viaje SET total_a_bordo = total_a_bordo + 1 WHERE ... AND total_a_bordo < capacidad_nominal`, inserta en `registro_de_asistencia`, invoca `fn_registrar_transicion_custodia` (WORM), registra `incidente` en caso de denegación y encola fila en `notificacion`.
- **Persistencia (`AttendanceModule`):** `ATTENDANCE_USE_POSTGRES=true` → `PostgresAttendanceRepository`; `false` (default) → `InMemoryAttendanceRepository` (serializa por `id_viaje` con mutex en memoria).

---

## 3. Endpoint HTTP y Eventos Socket.IO

### `POST /api/v1/asistencia/abordaje` (`200 OK`)

- **Seguridad:** JWT + `@Roles(MONITORA, ADMIN, COORDINADORA_CONVIVENCIA, JEFE_OPERACIONES)`.
- **Cabecera opcional:** `X-Idempotency-Key` (prioritaria sobre `dto.idempotency_key`).
- **Cuerpo (`RegisterBoardingDto`):**
  - `id_viaje` (UUID, obligatorio)
  - `qr_token` (cadena no vacía, máx. 512 chars, obligatorio)
  - `coordenadas_gps`: `{ latitud: [-90, 90], longitud: [-180, 180] }` (obligatorio)
  - `id_parada` (UUID, opcional)
  - `metodo_validacion`: `QR_INSTITUCIONAL` (default) | `QR_OCASIONAL_TEMPORAL` | `VERIFICACION_VISUAL_PARADA`
  - `sincronizado_offline` (booleano, default `false`)
  - `idempotency_key` (cadena, máx. 120 chars, opcional)

#### Respuesta estructurada no fatal (`200 OK`, `BoardingResponse`)

| `codigo` | `aprobado` | Efecto |
| --- | --- | --- |
| `ABORDAJE_EXITOSO` | `true` | Incrementa `total_a_bordo`, registra asistencia `ABORDAJE`, actualiza FSM a `A_BORDO_VEHICULO`, emite `student:boarded` y encola push al acudiente titular. |
| `DENEGADO_SOBRECUPO` | `false` | No incrementa `total_a_bordo`; registra incidente `INTENTO_SOBRECUPO` (`CRITICO`), audita `INTENTO_SOBRECUPO_DENEGADO` y emite `coordination:overcapacity_alert`. |
| `ABORDAJE_PREVIO_EXISTE` | `false` | No incrementa `total_a_bordo`; registra incidente `DOBLE_ABORDAJE_DETECTADO` (`ADVERTENCIA`) y audita `DOBLE_ABORDAJE_RECHAZADO` (indica `duplicado_por_idempotencia`). |

#### Errores HTTP fatales

- `400`: DTO o coordenadas WGS84 inválidas.
- `401` / `403`: sin JWT válido o rol no autorizado.
- `404`: viaje no encontrado (`TripNotFoundError`).
- `409`: viaje no está en estado `EN_CURSO` (`TripNotInProgressError`).
- `422`: QR inválido/expirado (`QR_INVALIDO`, `QR_EXPIRADO`) o estudiante no asignado a la ruta del viaje (`StudentNotAssignedToRouteError`).

### Eventos Socket.IO (namespace `/asistencia`)

- **Suscripciones del cliente:** `subscribe:trip` (`{ id_viaje }` → sala `viaje:<id_viaje>`) y `subscribe:coordination` (→ sala `coordinacion`).
- **`student:boarded`:** emitido al confirmarse `ABORDAJE_EXITOSO` *(actualmente mediante `this.server.emit(...)` al namespace `/asistencia`)*.
- **`coordination:overcapacity_alert`:** emitido a la sala `coordinacion` cuando ocurre `DENEGADO_SOBRECUPO`.

---

## 4. Reglas de Negocio

- **Prohibición estricta de sobrecupo (`RN-02`):** si un vehículo de capacidad `N` ya tiene `N` pasajeros a bordo, el escaneo `N+1` jamás incrementa `total_a_bordo`, devuelve `DENEGADO_SOBRECUPO` (`200 OK`) y genera incidente + alerta crítica.
- **Rechazo de doble abordaje (`RN-05`):** un estudiante solo puede tener un evento `ABORDAJE` por viaje; tanto el reescaneo directo como un reintento con la misma `idempotency_key` devuelven `ABORDAJE_PREVIO_EXISTE` sin duplicar cupo.
- **Soporte a QR dinámico y estático:**
  - Si el token comienza por `cs-qr:`, exige formato `cs-qr:v1:<uuid>:<exp>:<sig_hex64>`, firma HMAC-SHA256 válida y `exp >= now`.
  - Cualquier otro token se trata como QR estático/ocasional y se compara mediante su `SHA-256` contra BD.
- **Latencia fuera del camino crítico:** las notificaciones push se despachan asíncronamente en `BoardingNotificationQueueService` con clave idempotente `abordaje:<id_viaje>:<id_estudiante>`.

---

## 5. Decisiones de Seguridad

- **Serialización anti-carrera (`OWASP ASVS V11.1`):** bloqueo `FOR UPDATE` por viaje en `fn_registrar_abordaje_atomico` (PostgreSQL) y mutex por `id_viaje` en memoria.
- **Verificación en tiempo constante:** `QrTokenValidator` valida firmas HMAC con `crypto.timingSafeEqual` y bloquea el arranque en `production` si `QR_DYNAMIC_HMAC_SECRET` mantiene el valor de desarrollo o mide `< 32` caracteres.
- **Nota de seguridad WebSocket:** `AttendanceRealtimeGateway` no aplica autenticación JWT en el handshake Socket.IO (los guards HTTP globales omiten contextos no-HTTP) y emite `student:boarded` al namespace completo `/asistencia`.

---

## 6. Cómo Probarlo

```bash
npx jest src/modules/attendance/attendance.service.spec.ts src/modules/attendance/attendance.http.spec.ts
```

O ejecutando toda la suite del módulo:

```bash
npx jest src/modules/attendance
```

*(Comprobado sobre `src/modules/attendance`: 5 suites aprobadas —incluyendo `attendance.service.spec.ts` y `attendance.http.spec.ts` con prueba de estrés concurrente 20 solicitudes sobre capacidad 5 → 5 aprobadas y 15 `DENEGADO_SOBRECUPO` en `< 200 ms`, más Socket.IO real—, 2 suites de integración PostgreSQL omitidas sin BD activa; 29 pruebas aprobadas, 5 omitidas.)*
