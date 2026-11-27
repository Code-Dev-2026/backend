# Pasarela WebSocket de Seguimiento en Vivo con Salas Segmentadas y Aislamiento Familiar (`RealtimeModule`)

- **Issue de referencia:** `#14` — *feat(realtime): pasarela WebSocket Socket.IO con salas segmentadas y aislamiento familiar* (Milestone: *Sprint 3: Tiempo real y notificaciones*).
- **Fuentes en el código:**
  - `src/modules/realtime/` (`realtime.module.ts`, `telemetry.gateway.ts`, `streaming-authorization.filter.ts`, `trip-subscription.manager.ts`, `ws-handshake.authenticator.ts`)
  - Dominio: `domain/realtime.constants.ts`, `domain/realtime.types.ts`, `domain/realtime-ports.ts`
  - Adaptadores: `infrastructure/in-memory-guardian-link.repository.ts`, `infrastructure/postgres-guardian-link.repository.ts`
  - Pruebas: `streaming-authorization.filter.spec.ts`, `trip-subscription.manager.spec.ts`, `ws-handshake.authenticator.spec.ts`, `telemetry.gateway.http.spec.ts` (E2E con clientes `socket.io-client` reales), `infrastructure/postgres-guardian-link.repository.integration.spec.ts`
  - Configuración: `src/config/env.validation.ts` y `.env.example` (`REALTIME_USE_POSTGRES`), registro en `src/app.module.ts`
  - Reutilizado sin modificación: `TokenService` y regla `MfaGuard` (Issue `#3`), `CustodyService.listTripCustody` (Issue `#7`), evento `telemetry.gps.recorded` (Issue `#12`); abordaje (`#8`) y desembarque (`#9`) siguen intactos.
  - DDL usado (sin migración nueva): `usuario` y `acudiente` (`V002`), `estudiante_acudiente` (`V003`), `viaje_estudiante.estado_custodia` (`V005`/`V014`).

---

## 1. Propósito

Permitir que los acudientes vean en vivo la ubicación del transporte escolar **solo mientras su hijo está `A_BORDO_VEHICULO`** (`RF-10`), sin exponer el viaje antes del abordaje ni después del desembarque (`RNF-02`), con latencia de difusión inferior a 1 s (`RNF-05`).

> **Fuera de alcance:** streaming de video en vivo y notificaciones push (Issue `#15`).

---

## 2. Conexión y Eventos (namespace `/telemetria`)

### Handshake autenticado (OWASP ASVS V3.2)

El middleware del namespace valida el JWT **antes** de crear el socket. El Access Token se envía en `auth.token` (con o sin prefijo `Bearer`) o en el header `Authorization: Bearer <token>`.

| Rechazo (`connect_error.data.code`) | Causa |
| --- | --- |
| `TOKEN_REQUIRED` | No se envió token. |
| `TOKEN_INVALID` | Firma inválida, token expirado o token provisional MFA (`typ` distinto de `access`). |
| `MFA_REQUIRED` | Rol con MFA obligatorio (`COORDINADORA_CONVIVENCIA`, `RECTORIA`, …) sin segundo factor, según la regla existente de `MfaGuard`. |
| `ROLE_NOT_ALLOWED` | Rol sin acceso al seguimiento (p. ej. `CONDUCTOR`, `ADMINISTRADOR_CARTERA`). |

**Clasificación del usuario** (`userHasAnyRole`, con equivalencias BD ↔ RBAC):

- **Personal** (`STAFF`): `ADMIN`, `SCHOOL_COORDINATOR`, `TRANSPORT_ADMIN` y `MONITOR` con sus equivalencias (`COORDINADORA_CONVIVENCIA`, `RECTORIA`, `GERENCIA_TRANSPORTE`, `JEFE_OPERACIONES`, `MONITORA`). Recibe el stream de cualquier viaje al que se suscriba.
- **Acudiente** (`GUARDIAN`): `ACUDIENTE` / `parent`. Recibe el stream filtrado por parentesco y custodia.

### Eventos

| Dirección | Evento | Payload / respuesta |
| --- | --- | --- |
| Cliente → servidor | `trip:subscribe` | `{ id_viaje }` → ack `{ subscribed, room, transmitiendo, motivo, estudiantes }` |
| Cliente → servidor | `trip:unsubscribe` | `{ id_viaje }` → ack `{ unsubscribed }` |
| Servidor → cliente | `trip:gps` | `{ id_viaje, id_vehiculo, placa, latitud, longitud, velocidad_kmh, rumbo_grados, fecha_hora }` (sin metadatos internos de ingesta) |
| Servidor → cliente | `trip:stream_status` | `{ id_viaje, suscrito, transmitiendo, motivo, estudiantes, fecha_hora }`: al re-suscribir por handshake y cada vez que cambia `transmitiendo` |
| Servidor → cliente | `auth:expired` | `{ motivo: "TOKEN_EXPIRADO", mensaje }` y cierre del socket |
| Servidor → cliente | `notification:new` | Notificación de la sala familiar `familia:{id_acudiente}` con confirmación por ack (Issue `#15`, ver [notifications-realtime.md](notifications-realtime.md)) |

`motivo`: `PERSONAL_AUTORIZADO`, `ESTUDIANTE_A_BORDO`, `SIN_ESTUDIANTE_A_BORDO`, `SIN_VINCULO_CON_VIAJE`, `ID_VIAJE_INVALIDO`, `LIMITE_SUSCRIPCIONES`. `estudiantes` contiene **solo los hijos del propio acudiente** (`id_estudiante`, `estado_custodia`); para personal va vacío.

### Salas segmentadas

- Cada viaje tiene la sala `trip:{id_viaje}`; `id_viaje` debe ser un UUID.
- Un acudiente **sin hijos inscritos** en el viaje recibe `SIN_VINCULO_CON_VIAJE` y no entra a la sala.
- Un acudiente con hijo inscrito pero aún no a bordo entra a la sala con `transmitiendo: false`; empieza a recibir frames cuando el hijo aborda.
- Máximo **5 salas** por socket.
- **Sala familiar (Issue `#15`):** al conectarse, cada acudiente entra solo a `familia:{id_acudiente}` de sus propios registros de `acudiente` (cuenta `ACTIVO`), donde recibe `notification:new`.

---

## 3. Filtro de Difusión y Corte post-Desembarque (SRP)

- **`TelemetryGateway`** solo gestiona la comunicación: handshake, suscripciones y emisión socket por socket de cada `telemetry.gps.recorded` (Issue `#12`). La difusión se lanza sin `await` para no frenar la ingesta y se serializa por viaje.
- **`StreamingAuthorizationFilter`** decide quién recibe cada frame. Por cada frame de un viaje con acudientes conectados hace **una** lectura, sin caché:
  1. `CustodyService.listTripCustody(id_viaje)` → estado de custodia de cada estudiante del viaje (`viaje_estudiante`, misma fuente que actualizan el abordaje #8 y el desembarque #9).
  2. `IGuardianLinkRepository.listGuardianLinksForStudents(...)` → `id_usuario` de los acudientes vinculados.

  El acudiente recibe el frame solo si **al menos uno de sus hijos** está `A_BORDO_VEHICULO` en ese momento.
- **Corte inmediato (criterio de aceptación):** al confirmarse el desembarque (#9), el estado de custodia del menor deja de ser `A_BORDO_VEHICULO`. Como el filtro relee ese estado en cada frame, el **siguiente** frame ya no se emite a ese acudiente, que recibe un único `trip:stream_status` con `transmitiendo: false` y `motivo: SIN_ESTUDIANTE_A_BORDO`. Los demás acudientes con hijos a bordo y el personal siguen recibiendo.
- **Silenciado vs. desconexión ([PROPUESTA] del SRS):** se implementa el **silenciado**. El socket permanece en la sala sin recibir coordenadas, de modo que, si otro hijo del mismo acudiente sigue en el viaje, el stream continúa sin reconectar.
- **Fail-closed:** si falla la lectura de custodia o de parentesco, ese frame no se emite a acudientes (el personal sí lo recibe).

---

## 4. Sesión, Throttle, Heartbeat y Reconexión

- **Autorización por mensaje (ASVS V3.2):** cada `trip:subscribe` y cada frame verifican la vigencia del Access Token (15 min, Issue `#3`). Al vencer se emite `auth:expired` y se cierra el socket; el cliente debe reconectar con un token renovado.
- **Throttle (mitigación de CPU):** máximo **1 frame cada 2 s por cliente y viaje**. Es de borde anterior: un frame que llega antes de los 2 s se descarta, nunca se retrasa, para no romper la latencia < 1 s.
- **Heartbeat:** se usa el ping/pong nativo de Engine.IO con los valores por defecto de Socket.IO 4 (`pingInterval` 25 s, `pingTimeout` 20 s), compartidos con el namespace `/asistencia`. Los sockets sin respuesta se cierran y su estado se libera en `handleDisconnect`.
- **Reconexión automática:** `socket.io-client` reconecta solo. Cada reconexión vuelve a pasar por el middleware JWT, y si el cliente envía `auth.id_viaje` (o `auth.id_viajes`, máx. 5) el servidor lo re-suscribe y le emite `trip:stream_status` con su estado actual.

```js
const socket = io("https://<host>/telemetria", {
  transports: ["websocket"],
  auth: { token: "<access_token>", id_viaje: "<uuid_viaje>" },
});
socket.on("trip:gps", (frame) => { /* actualizar mapa */ });
socket.on("trip:stream_status", (s) => { /* s.transmitiendo */ });
```

---

## 5. Persistencia del Parentesco (`REALTIME_USE_POSTGRES`)

| Valor | Adaptador | Fuente |
| --- | --- | --- |
| `false` (defecto) | `InMemoryGuardianLinkRepository` | Registro en memoria (`registerLink`) para pruebas y desarrollo. |
| `true` | `PostgresGuardianLinkRepository` | `estudiante_acudiente` ⋈ `acudiente` ⋈ `usuario` con `usuario.estado = 'ACTIVO'`; consulta parametrizada (`ANY($1::uuid[])`) con validación previa de UUID. |

El estado de custodia siempre se lee con `CustodyService`, que respeta `CUSTODY_USE_POSTGRES`.

---

## 6. Métricas

`TelemetryGateway.getMetrics()` expone: `framesReceived`, `framesRejected`, `framesWithoutSubscribers`, `framesEmitted`, `framesThrottled`, `framesBlockedByCustody`, `audienceErrors`, `expiredSessions`, `rejectedHandshakes`, `overBudgetDispatches` (difusiones ≥ 1 s), `maxDispatchMs` y `connectedSockets`.

---

## 7. Cómo Probarlo

Pruebas unitarias y E2E con clientes Socket.IO reales: handshake rechazado sin token, con token inválido, rol no permitido o sin MFA; criterio de aceptación `V-100` con desembarque HTTP real; hijo no abordado, acudiente ajeno, throttle, expiración de token, reconexión y latencia:

```bash
npx jest src/modules/realtime
```

Integración real contra PostgreSQL 16 (migraciones `V001`–`V019` aplicadas, credenciales de `app_user` desde `db/.env`):

```bash
RUN_POSTGRES_TESTS=true DB_USER=app_user DB_PASSWORD=<clave-app_user> npx jest src/modules/realtime/infrastructure --runInBand
```

*(Comprobado en esta rama: `npm run build` OK; `npm test` 67 suites aprobadas, 9 de integración BD omitidas sin flag, 530 pruebas aprobadas y 28 omitidas; `npx jest src/modules/realtime` 41 aprobadas (3 de integración omitidas sin flag), estable en ejecuciones consecutivas; integración real PostgreSQL 16 + PostGIS 3.4 con `app_user`, 9/9 suites y 28/28 pruebas aprobadas; `npm run lint` no se puede ejecutar porque falta el archivo `.eslintrc.*` en el repositorio, problema que ya existía.)*
