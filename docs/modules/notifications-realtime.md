# Despachador de Notificaciones y Eventos en Tiempo Real (`NotificationDispatcherService`)

- **Issue de referencia:** `#15` — *feat(notifications): despachador de notificaciones y eventos en tiempo real con WebSocket / Socket.IO* (Milestone: *Sprint 3: Tiempo real y notificaciones*).
- **Fuentes en el código:**
  - `src/modules/notifications/`: `notification-dispatcher.service.ts`, `notification-channel.registry.ts`, `custody-transition.notifier.ts`, `notifications.module.ts`
  - Dominio: `domain/notification-dispatch.types.ts`, `domain/notification-dispatch.ports.ts` (`INotificationChannelPort`, `INotificationRepository`, `INotificationRecipientDirectory`)
  - Adaptadores: `infrastructure/in-memory-notification.repository.ts`, `infrastructure/postgres-notification.repository.ts`, `infrastructure/notification-recipient.directory.ts`
  - Canal Socket.IO: `src/modules/realtime/infrastructure/family-room-notification.channel.ts` y la sala familiar en `src/modules/realtime/telemetry.gateway.ts` (Issue `#14`)
  - Puntos de integración (cambios retrocompatibles):
    - `src/modules/attendance/boarding-notification-queue.service.ts` (#8/#9)
    - `src/modules/custody/custody.controller.ts` y `custody.module.ts` (#7)
  - Pruebas: `notification-dispatcher.service.spec.ts`, `custody-transition.notifier.spec.ts`, `notification-dispatcher.realtime.http.spec.ts` (E2E con `socket.io-client`), `infrastructure/postgres-notification.repository.integration.spec.ts`
  - Configuración: `NOTIFICATIONS_USE_POSTGRES` en `src/config/env.validation.ts` y `.env.example`
  - DDL usado (sin migración nueva): `tipo_notificacion` y `notificacion` (`V007`), `estudiante_acudiente` (`V003`), `acudiente` y `usuario` (`V002`).

---

## 1. Propósito

Notificar al instante a la familia legitimada cada cambio de custodia del menor (abordaje, desembarque, aproximación y fallo de entrega). Cada notificación se emite por Socket.IO a la **sala familiar** del acudiente y queda registrada en `notificacion`, clasificada por `tipo_notificacion`, con latencia inferior a 2,5 s (`RF-12`, `RF-20`, `RNF-05`).

> **Fuera de alcance:** proveedores de mensajería externos (FCM, SMS, WhatsApp). Las alertas judiciales del Issue `#10` (SMS y Policía de Infancia) siguen su propio canal sin cambios.

---

## 2. Qué Eventos se Notifican y Desde Dónde

| Evento | Origen | `tipo_notificacion` | `idempotency_key` |
| --- | --- | --- | --- |
| Abordaje | `AttendanceService` → `BoardingNotificationQueueService` (#8) | `ABORDAJE_EXITOSO` | `abordaje:{id_viaje}:{id_estudiante}` |
| Desembarque exitoso | `DisembarkUseCase` → cola (#9) | `DESCENSO_EXITOSO` | `descenso:{id_entrega}:{id_acudiente}` |
| Fallo de entrega / retorno a sede | `DisembarkUseCase` → cola (#9) | `INCIDENTE_ENTREGA` | `fallo_entrega:{id_entrega}:{id_acudiente}` |
| Recepción formal en sede | `DisembarkUseCase` → cola (#9) | `DESCENSO_EXITOSO` | `acta_sede:{id_acta}:{id_acudiente}` |
| Transición FSM vía `POST /custody/transitions` (#7) | `CustodyController` → `CustodyTransitionNotifier` | según el estado destino (tabla siguiente) | `transicion:{id_historial}:{id_acudiente}` |

Clasificación de las transiciones manuales de la FSM (`CUSTODY_TRANSITION_TEMPLATES`):

| Estado destino | `tipo_notificacion` | Significado |
| --- | --- | --- |
| `EN_ESPERA_ABORDAJE` | `PROXIMIDAD_PARADA` | **Aproximación**: el vehículo llega a la parada de abordaje (p. ej. disparador `LLEGADA_PARADA_ABORDAJE`). |
| `A_BORDO_VEHICULO` | `ABORDAJE_EXITOSO` | Abordaje confirmado. |
| `ENTREGADO_ACUDIENTE` / `EN_COLEGIO` | `DESCENSO_EXITOSO` | Entrega en parada / llegada a la sede. |
| `RETORNO_SEDE_POR_FALLA_ENTREGA` | `INCIDENTE_ENTREGA` | Alerta crítica de retorno seguro. |

- **Sin duplicados con PostgreSQL:** las claves de la cola son **idénticas** a las que ya usan las funciones atómicas `V015`/`V016`. En modo PostgreSQL el despachador encuentra la fila que esas funciones crearon (`ON CONFLICT (idempotency_key)`) y la entrega, sin insertar otra.
- **Sin duplicados entre orígenes:** las transiciones internas del abordaje y del desembarque no pasan por `CustodyController`, así que solo las notifica la cola.
- **Retrocompatibilidad:** si `NotificationDispatcherService` no está disponible, la cola conserva el comportamiento anterior de #8/#9.

---

## 3. Flujo del Despachador

1. **Cola en memoria asíncrona y no bloqueante** (mitigación de horas pico): `enqueue()` retorna de inmediato al caso de uso y la cola procesa con concurrencia acotada (`maxConcurrency`, 20 por defecto).
2. **Persistencia en `notificacion`** (`INotificationRepository.upsertPending`):
   - el tipo y el canal por defecto se toman de `tipo_notificacion` (`INSERT … SELECT … WHERE codigo = $`);
   - estado inicial `PENDIENTE`;
   - es idempotente por `idempotency_key`. Si la fila ya está `ENTREGADA` o `LEIDA`, no se reenvía.
3. **Entrega por canales** (`INotificationChannelPort`): se entrega a todos los canales registrados en `NotificationChannelRegistry`.
4. **Confirmación y reintentos**:

   | Resultado del intento | Estado registrado |
   | --- | --- |
   | El cliente confirma (ack) | `ENTREGADA` (`entregada_en`) |
   | Emitido pero sin ack | `ENVIADA` (`despachada_en`) y se reintenta |
   | El acudiente no tiene sesión activa | `REINTENTO` y se reintenta |
   | Se agota `max_intentos` (3) | `FALLIDA`, con el motivo en `ultimo_error` |

   Cada intento incrementa `intentos_realizados`. Esperas entre reintentos por defecto: 1 s y 3 s.
5. Si no hay ningún canal registrado, la fila queda `PENDIENTE`. Si falla la persistencia, no se emite nada.

### OCP y DIP

- La lógica central no conoce el transporte. Los canales implementan `INotificationChannelPort` y se **registran solos** desde su módulo (`FamilyRoomNotificationChannel` en `RealtimeModule`), sin dependencias circulares entre módulos.
- Para añadir un evento nuevo de custodia basta con añadir una entrada en `CUSTODY_TRANSITION_TEMPLATES`.
- Los casos de uso dependen de abstracciones (`NotificationDispatcherService`, `INotificationRepository`, `INotificationRecipientDirectory`).

---

## 4. Canal Socket.IO de la Sala Familiar (segmentación y privacidad)

- **Sala `familia:{id_acudiente}`** en el namespace `/telemetria` (Issue `#14`). Al conectarse, un socket con rol de acudiente, ya autenticado por JWT en el handshake, entra **solo** a las salas de los `id_acudiente` de su propio `id_usuario` (`acudiente.id_usuario`, cuenta `ACTIVO`). El personal no entra a salas familiares.
- **Evento `notification:new`** con payload `{ id_notificacion, codigo_tipo, id_acudiente, id_estudiante, id_viaje, titulo, mensaje, payload, silenciable, intento, fecha_hora }`. El cliente confirma con el callback de ack de Socket.IO. Plazo de confirmación por defecto: 1,5 s.
- **Pertenencia al menor:** el destinatario sale del vínculo `estudiante_acudiente`. En PostgreSQL, la FK `fk_notif_estudiante_acudiente` impide incluso guardar una notificación para un acudiente sin vínculo con el menor (verificado en la prueba de integración).
- Un mismo `id_notificacion` puede llegar varias veces si se reintenta sin ack. El cliente debe descartar duplicados por `id_notificacion`.

```js
const socket = io("https://<host>/telemetria", { auth: { token: "<access_token>" } });
socket.on("notification:new", (n, ack) => {
  mostrar(n);                                   // descartar si n.id_notificacion ya se mostró
  ack({ recibida: true, id_notificacion: n.id_notificacion });
});
```

---

## 5. Persistencia (`NOTIFICATIONS_USE_POSTGRES`)

| Valor | Repositorio | Directorio de destinatarios |
| --- | --- | --- |
| `false` (defecto) | `InMemoryNotificationRepository` (espejo de `idempotency_key` UNIQUE y del canal por defecto de V007) | `InMemoryNotificationRecipientDirectory` (`registerGuardian`) |
| `true` | `PostgresNotificationRepository` sobre `notificacion` ⋈ `tipo_notificacion` | `PostgresNotificationRecipientDirectory`: `estudiante_acudiente` ⋈ `acudiente` ⋈ `usuario` (`ACTIVO`), ordenado por `es_tutor_principal` y `orden_notificacion` |

La sala familiar resuelve `id_usuario` → `id_acudiente` con el repositorio de parentesco del Issue `#14` (`REALTIME_USE_POSTGRES`).

---

## 6. Métricas

`NotificationDispatcherService.getMetrics()` expone: `enqueued`, `delivered`, `failed`, `duplicatesSkipped`, `retries`, `persistenceErrors`, `overBudget` (entregas ≥ 2,5 s), `maxLatencyMs`, `queued` e `inFlight`.

---

## 7. Cómo Probarlo

Pruebas unitarias con canales WebSocket simulados (persistencia, idempotencia, reintentos, `FALLIDA`, OCP, cola con 300 eventos concurrentes) y E2E con clientes Socket.IO reales sobre los flujos HTTP de abordaje, desembarque y `POST /custody/transitions`:

```bash
npx jest src/modules/notifications
```

Integración real contra PostgreSQL 16 (migraciones `V001`–`V019` aplicadas, credenciales de `app_user` desde `db/.env`):

```bash
RUN_POSTGRES_TESTS=true DB_USER=app_user DB_PASSWORD=<clave-app_user> npx jest src/modules/notifications/infrastructure --runInBand
```

*(Comprobado en esta rama: `npm run build` OK; `npm test` 70 suites aprobadas, 10 de integración BD omitidas sin flag, 553 pruebas aprobadas y 35 omitidas; integración real PostgreSQL 16 + PostGIS 3.4 con `app_user`, 10/10 suites y 35/35 pruebas aprobadas en dos ejecuciones consecutivas. En una ejecución anterior la suite de rutas `postgis-geo.repository.integration.spec.ts` del Issue `#6`, no modificada en esta rama, falló una vez por espera y luego pasó sola y en conjunto. `npm run lint` no se puede ejecutar porque falta el archivo `.eslintrc.*` en el repositorio, problema que ya existía.)*
