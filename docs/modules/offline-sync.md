# Sincronización Offline Idempotente para Dispositivos de Monitoras (`OfflineModule`)

- **Issue de referencia:** `#16` — *feat(offline): sincronización offline idempotente para dispositivos móviles de monitores* (Milestone: *Sprint 3: Tiempo real y notificaciones*).
- **Fuentes en el código:**
  - `src/modules/offline/` (`offline.module.ts`, `offline.controller.ts`, `offline-sync.processor.ts`)
  - Dominio: `domain/offline-sync.types.ts`, `domain/offline-sync.ports.ts`
  - Handlers de casos de uso: `handlers/offline-operation.handlers.ts` (`BoardingOfflineHandler`, `DisembarkOfflineHandler`), `handlers/validate-dto.ts`
  - DTO: `dto/offline-sync.dto.ts`
  - Adaptadores: `infrastructure/in-memory-offline-sync.repositories.ts`, `infrastructure/postgres-offline-sync.repositories.ts`
  - Pruebas: `offline-sync.processor.spec.ts`, `offline-sync.http.spec.ts`, `infrastructure/postgres-offline-sync.repositories.integration.spec.ts`
  - Configuración: `OFFLINE_USE_POSTGRES` en `src/config/env.validation.ts` y `.env.example`
  - Reutilizado sin modificación: `AttendanceService.registerBoarding` (abordaje, Issue `#8`), `DisembarkUseCase.executeDisembark` (descenso, Issue `#9`) y sus DTOs `RegisterBoardingDto` / `RegisterDisembarkDto`. A través de ellos se aplica la FSM de custodia (Issue `#7`).
  - DDL usado (sin migración nueva): `sync_operation` con `UNIQUE (id_dispositivo, idempotency_key)` (`V007`) y `dispositivo` (`V002`).
  - **Reemplazo:** se retiró el stub previo `POST /offline/sync` (`offline.service.ts`), que respondía `RECONCILIADO_EXITOSAMENTE` sin procesar nada.

---

## 1. Propósito

La app de la monitora guarda en SQLite local los abordajes y descensos tomados en puntos ciegos de cobertura (p. ej. Vía La Florida, Canceles) y los sincroniza al recuperar señal. El servidor los aplica **una sola vez**, aunque el lote se retransmita varias veces por cortes de red (`RF-06`, `RF-08`, `RNF-04`, `RNF-08`).

> **Fuera de alcance:** resolución de conflictos de edición simultánea multiusuario (el viaje lo opera solo la monitora asignada).

---

## 2. Endpoint `POST /api/v1/sync/offline`

| Aspecto | Detalle |
| --- | --- |
| Autenticación | JWT obligatorio (`401` sin token). |
| Rol | `MONITORA` (`403` para otros roles). |
| Clave de dispositivo | `id_dispositivo` debe existir en `dispositivo`, estar `activo` y pertenecer al `id_usuario` del JWT. Si no, responde `403` con `code: DISPOSITIVO_NO_AUTORIZADO`. |
| Lote | `operaciones`: de 1 a 100. |
| Operación | `idempotency_key` (8–64 caracteres `[A-Za-z0-9._:-]`, generada en el dispositivo), `tipo` (`ABORDAJE` \| `DESCENSO`), `fecha_cliente` (ISO-8601 estricto) y `datos`. |
| `datos` | El **mismo cuerpo** de `POST /asistencia/abordaje` o `POST /asistencia/descenso`, validado con sus DTOs y las mismas reglas que el `ValidationPipe` HTTP. El servidor ignora `idempotency_key` y `sincronizado_offline` si vienen dentro de `datos`. |
| Respuesta | `200` con un reporte por operación (siguiente sección). El esquema inválido responde `400`. |

```json
{
  "id_dispositivo": "018e38d9-3f00-7200-a000-0000000d0001",
  "operaciones": [
    {
      "idempotency_key": "scan-2026-11-27-0001",
      "tipo": "ABORDAJE",
      "fecha_cliente": "2026-11-27T12:05:31.000Z",
      "datos": { "id_viaje": "<uuid>", "qr_token": "<qr>", "coordenadas_gps": { "latitud": 4.81, "longitud": -75.69 } }
    }
  ]
}
```

### Reporte por operación

`{ total, procesadas, duplicadas, conflictos, descartadas, errores_transitorios, operaciones[], fecha_servidor }`. Cada operación trae `{ idempotency_key, tipo, estado, duplicado, codigo, orden_aplicacion, fecha_cliente, fecha_servidor, id_sync, resultado }`.

| `estado` | Cuándo | `sync_operation.estado_sync` |
| --- | --- | --- |
| `PROCESADO` | El caso de uso la aplicó (p. ej. `ABORDAJE_EXITOSO`, `DESCENSO_EXITOSO`, `DESEMBARQUE_FALLIDO_RETORNO`). | `PROCESADO` |
| `CONFLICTO` | Rechazo de negocio: respuesta no fatal (`DENEGADO_SOBRECUPO`, `ABORDAJE_PREVIO_EXISTE`) o excepción 4xx del caso de uso (viaje no `EN_CURSO`, estudiante no a bordo, receptor no autorizado…). | `CONFLICTO` |
| `DESCARTADO` | `fecha_cliente` con desfase > 24 h (`DESFASE_TEMPORAL`) o `datos` inválidos (`PAYLOAD_INVALIDO`). No se ejecuta. | `DESCARTADO` |
| `ERROR_TRANSITORIO` | Error inesperado del servidor (`codigo: REINTENTAR`). La app debe reenviarla. | queda `PENDIENTE` |

- `duplicado: true` indica que la operación ya se había resuelto antes. El servidor devuelve el **mismo resultado guardado**, sin volver a ejecutar el caso de uso.
- El lote no es todo-o-nada: una operación en conflicto no impide aplicar las demás.

---

## 3. Procesamiento (`OfflineSyncProcessor`, SRP)

El procesador solo deserializa, ordena y coordina la idempotencia. Las reglas de negocio las ejecutan los casos de uso existentes (en el repositorio, el "AbordajeUseCase" y el "DescensoUseCase" que menciona la issue son `AttendanceService.registerBoarding` y `DisembarkUseCase.executeDisembark`).

1. **Orden cronológico** ([PROPUESTA] del SRS): las operaciones se ordenan por `fecha_cliente` (orden estable) antes de aplicarse. `orden_aplicacion` informa la posición resultante; por ejemplo, un abordaje anterior se aplica antes que el descenso del mismo menor.
2. **Reserva idempotente:** se inserta `(id_dispositivo, idempotency_key)` en `sync_operation` como `PENDIENTE`, con `ON CONFLICT DO NOTHING`. Si ya existía con estado final, se responde como duplicado. Las claves repetidas dentro del mismo lote también se deduplican.
3. **Desfase temporal (ASVS V11.1):** si `|fecha_cliente − reloj del servidor| > 24 h`, la operación queda `DESCARTADO`. Se guarda `capturada_en_offline` (reloj del cliente) y `procesada_en_servidor` (`clock_timestamp()`), lo que deja auditada la `fecha_servidor`.
4. **Delegación:** el handler valida `datos` con el DTO HTTP y llama al caso de uso con `sincronizado_offline: true` e `idempotency_key: offline:{id_dispositivo}:{idempotency_key}`. Esta es la **segunda barrera** contra duplicados.
5. **Resultado:** se registra el `estado_sync` final y el `resultado_json`.
6. **Retransmisiones simultáneas** del mismo dispositivo se procesan en serie dentro de una instancia. Entre instancias del backend, la deduplicación la garantiza el `UNIQUE` de la BD (verificado en la prueba de integración con dos pools).

### Transacciones seguras y compensación

- Cada operación es atómica en su caso de uso (`fn_registrar_abordaje_atomico` / `fn_registrar_descenso_atomico` en PostgreSQL, o mutex por viaje en memoria).
- Si el servidor falla **después** de aplicar el caso de uso pero **antes** de cerrar `sync_operation`, la fila queda `PENDIENTE`. El reintento de la app la reprocesa con la misma clave idempotente y el caso de uso no duplica el registro.
  - En ese caso poco frecuente, el abordaje responde `ABORDAJE_PREVIO_EXISTE` y deja su incidente informativo.

### Privacidad (Ley 1581)

`payload_json` de `sync_operation` guarda la operación con los campos sensibles reemplazados por `[REDACTADO]`: `qr_token` en abordaje; `documento_receptor` y `foto_evidencia_url` en descenso. El caso de uso sí recibe los valores reales.

---

## 4. Persistencia (`OFFLINE_USE_POSTGRES`)

| Valor | `sync_operation` | `dispositivo` |
| --- | --- | --- |
| `false` (defecto) | `InMemorySyncOperationRepository` (espejo del `UNIQUE`) | `InMemoryDeviceRegistry` (`registerDevice`) |
| `true` | `PostgresSyncOperationRepository` (`INSERT … ON CONFLICT (id_dispositivo, idempotency_key) DO NOTHING`, `UPDATE … SET procesada_en_servidor = clock_timestamp()`) | `PostgresDeviceRegistry` (`id_usuario`, `activo`) |

Los casos de uso de abordaje y descenso respetan su propio flag (`ATTENDANCE_USE_POSTGRES`).

---

## 5. Cómo Probarlo

Pruebas unitarias del procesador (retransmisión doble, orden cronológico, dispositivo ajeno o inactivo, desfase ±24 h, duplicados en el lote, `CONFLICTO`, compensación tras error transitorio, redacción de datos sensibles, retransmisiones simultáneas y ráfaga de 100) y pruebas HTTP con los casos de uso reales de abordaje y descenso:

```bash
npx jest src/modules/offline
```

Integración real contra PostgreSQL 16 (migraciones `V001`–`V019` aplicadas, credenciales de `app_user` desde `db/.env`):

```bash
RUN_POSTGRES_TESTS=true DB_USER=app_user DB_PASSWORD=<clave-app_user> npx jest src/modules/offline/infrastructure --runInBand
```

*(Comprobado en esta rama: `npm run build` OK; `npm test` 71 suites aprobadas, 11 de integración BD omitidas sin flag, 580 pruebas aprobadas y 40 omitidas; integración real PostgreSQL 16 + PostGIS 3.4 con `app_user`, 11/11 suites y 40/40 pruebas aprobadas; `npm run lint` no se puede ejecutar porque falta el archivo `.eslintrc.*` en el repositorio, problema que ya existía.)*
