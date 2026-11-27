# Motor de Protección Preventiva contra Alertas Judiciales (`CustodyModule` + `AttendanceModule`)

- **Issue de referencia:** `#10` — *feat(custody): motor de protección preventiva contra alertas judiciales activas*.
- **Fuentes en el código:**
  - `src/modules/custody/judicial-alerts/` (`judicial-alerts.controller.ts`, `judicial-alerts.service.ts`, `domain/judicial-alert.types.ts`, `domain/judicial-alert-repository.port.ts`, `dto/judicial-alert.dto.ts`, `infrastructure/in-memory-judicial-alert.repository.ts`, `infrastructure/postgres-judicial-alert.repository.ts`)
  - `src/modules/attendance/` (`domain/delivery-interceptor.interface.ts`, `judicial-alert-delivery.interceptor.ts`, `disembark.use-case.ts`, `incident-logger.service.ts`, `boarding-notification-queue.service.ts`, `domain/disembark.types.ts`, `infrastructure/attendance-realtime.gateway.ts`, `infrastructure/in-memory-attendance.repository.ts`, `infrastructure/postgres-attendance.repository.ts`)
  - `src/modules/notifications/notifications.service.ts`, `src/common/filters/all-exceptions.filter.ts`
  - DDL asociado: `db/migrations/V003__students_and_custody_vault.sql`, `V007__notifications_and_offline_sync.sql`, `db/migrations/V017__judicial_alerts_protection_engine.sql` y `db/migrations/undo/U017__judicial_alerts_protection_engine.sql`

---

## 1. Propósito

Impedir de forma automática y categórica la entrega de un menor a un progenitor o tercero que cuente con una medida judicial o de protección activa en `alerta_judicial` (`RF-02`, `RF-09`, `RNF-01`), operando exclusivamente mediante cruce determinista por blind index (`documento_restringido_hash`, HMAC-SHA256) sobre el documento único de identidad normalizado, sin bloquear jamás el abordaje del estudiante al vehículo escolar.

> **Alcance explícito:** el módulo se alimenta por Coordinación/Rectoría; no establece conexión directa en línea con bases de datos de la Fiscalía o la Rama Judicial.

---

## 2. Arquitectura OCP, Entidades y Tablas

### Principio OCP (`DeliveryInterceptor`)

- **`DeliveryInterceptor` y `DeliveryInterceptorChain`** (`src/modules/attendance/domain/delivery-interceptor.interface.ts`): cadena de responsabilidad ordenada por `priority` ejecutada en `DisembarkUseCase.executeDisembark` antes de validar el receptor. Permite registrar nuevas reglas cautelares sin modificar el núcleo de desembarque.
- **`JudicialAlertDeliveryInterceptor`** (`priority = 1`): interceptor preventivo que consulta `JudicialAlertsService` y el directorio del estudiante, activa el protocolo de emergencia ante coincidencia y falla de forma segura (`JudicialProtectionEngineError`, HTTP `503`) ante cualquier fallo técnico del motor.

### Gestión de Alertas (`JudicialAlertsService`)

- Cifra en reposo con **AES-256-GCM** (`CryptoVaultService`, dominio `formato_cifrado_aes`): `individuo_restringido_nombre_cifrado`, `individuo_restringido_documento_cifrado`, `orden_judicial_resumen_cifrado` y `foto_individuo_cifrada`.
- Normaliza el documento (`normalizeDocument`) y calcula `documento_restringido_hash` / `individuo_blind_index` vía **HMAC-SHA256** (`CryptoVaultService.generateBlindIndex`) más `hash_integridad_sha256` (`HashService.sha256`).
- Persistencia dual: `PostgresJudicialAlertRepository` si `CUSTODY_USE_POSTGRES=true` o `ATTENDANCE_USE_POSTGRES=true`; `InMemoryJudicialAlertRepository` en caso contrario.

### Tablas y Cambios DDL (`V003`, `V007`, `V017`)

- **Tablas involucradas:** `alerta_judicial`, `entrega`, `incidente`, `notificacion` (y catálogo semilla `tipo_notificacion` con `ALERTA_JUDICIAL_ACTIVADA` de `V007`).
- **Cambios en `V017__judicial_alerts_protection_engine.sql`** *(reversibles mediante `db/migrations/undo/U017__judicial_alerts_protection_engine.sql`)*:
  1. Agrega la columna generada almacenada `documento_restringido_hash VARCHAR(64) GENERATED ALWAYS AS (LOWER(individuo_blind_index)) STORED` en `public.alerta_judicial` + restricción `chk_alerta_judicial_blind_index_hex` (64 hex) + índice parcial `idx_alerta_judicial_estudiante_doc_hash (id_estudiante, documento_restringido_hash) WHERE activa = TRUE AND eliminado_soft = FALSE`.
  2. Crea `fn_verificar_alerta_judicial_activa(p_id_estudiante, p_documento_restringido_hash)` para consulta determinista sin exponer columnas cifradas.
  3. Actualiza `fn_registrar_descenso_atomico(...)` para invocar `fn_verificar_alerta_judicial_activa` con prioridad absoluta y lanzar `ALERTA_JUDICIAL_BLOQUEANTE` (`SQLSTATE 42501`) antes de validar acudiente/autorizado o mutar `viaje.total_a_bordo` y `viaje_estudiante`.
  4. Agrega el trigger `trg_bloquear_entrega_por_alerta_judicial` (`BEFORE INSERT OR UPDATE` sobre `public.entrega`) que impide incluso inserciones directas a `entrega` ante coincidencia judicial activa.
  5. Crea `fn_registrar_incidente_alerta_judicial(...)` para insertar atómicamente el acta `CRITICO` en `incidente` (`ALERTA_JUDICIAL_DETECTADA`) y las notificaciones `SMS` no silenciables (`ALERTA_JUDICIAL_ACTIVADA`) en `notificacion` excluyendo al acudiente cuyo `documento_blind_index` coincida con `documento_restringido_hash`.
  6. Otorga `GRANT EXECUTE` sobre las 3 funciones a `app_user` y `app_user_operations`, manteniendo a `app_user_operations` con privilegio exclusivo de `SELECT` sobre `alerta_judicial` (`OWASP ASVS V1.14`).

---

## 3. Endpoints HTTP y Eventos Socket.IO

### Gestión y Consulta (`JudicialAlertsController`, prefijo `/api/v1/custody/judicial-alerts`)

Todas las respuestas incluyen cabecera `Cache-Control: no-store`.

| Método y Ruta | Roles | Descripción y respuestas clave |
| --- | --- | --- |
| `POST /api/v1/custody/judicial-alerts` | `COORDINADORA_CONVIVENCIA`, `RECTORIA`, `ADMIN` *(MFA obligatorio)* | Registra medida cautelar cifrada AES-256-GCM + blind index HMAC (`201`, `400` DTO/documento inválido, `401` sin JWT o sin MFA, `403` rol no permitido, `409` radicado duplicado). |
| `GET /api/v1/custody/judicial-alerts/students/:studentId` | `COORDINADORA_CONVIVENCIA`, `RECTORIA`, `ADMIN` *(MFA obligatorio)* | Lista alertas de un estudiante con documento enmascarado (`?incluir_inactivas=true` opcional, `200`). |
| `POST /api/v1/custody/judicial-alerts/verify` | `MONITORA`, `COORDINADORA_CONVIVENCIA`, `RECTORIA`, `ADMIN`, `JEFE_OPERACIONES` | Cruce determinista por `documento_receptor` o `documento_restringido_hash`; responde `ALERTA_JUDICIAL_BLOQUEANTE` o `SIN_RESTRICCION_JUDICIAL` sin exponer PII descifrada (`200`, `400`). |
| `PATCH /api/v1/custody/judicial-alerts/:alertId/deactivate` | `COORDINADORA_CONVIVENCIA`, `RECTORIA`, `ADMIN` *(MFA obligatorio)* | Desactivación lógica auditable (`activa = false`, `eliminado_soft = true`; `200`, `404`, `409` ya inactiva). |

### Integración en Desembarque (`POST /api/v1/asistencia/descenso`)

- Ante coincidencia con una alerta judicial activa para el estudiante y el documento digitado/escaneado (o `documento_blind_index`), responde **`403 Forbidden`** con `code: "ALERTA_JUDICIAL_BLOQUEANTE"` y `error: "ALERTA_JUDICIAL_BLOQUEANTE"`.
- Ante fallo técnico del motor de verificación judicial, responde **`503 Service Unavailable`** con `code: "MOTOR_JUDICIAL_NO_DISPONIBLE_BLOQUEO_SEGURO"`, manteniendo al menor a bordo y registrando incidente `CRITICO` (`ERROR_MOTOR_PROTECCION_JUDICIAL`).

### Eventos Socket.IO (namespace `/asistencia`, sala `coordinacion`)

- `coordination:judicial_alert`: payload `JudicialAlertEventPayload` (`codigo: "ALERTA_JUDICIAL_BLOQUEANTE"`, `tipo_notificacion: "ALERTA_JUDICIAL_ACTIVADA"`, `severidad: "CRITICO"`, `id_alerta`, `id_incidente`, `radicado_medida`, `juzgado_emisor`, `menor_permanece_a_bordo: true`, `notificaciones_sms_emergencia`, `alerta_policia_infancia_enviada: true`, coordenadas y timestamp).
- También emite `coordination:unauthorized_receptor_alert` con `codigo: "ALERTA_JUDICIAL_BLOQUEANTE"` y `severidad: "CRITICO"` para compatibilidad con consumidores del Issue `#9`.

---

## 4. Reglas de Negocio y Flujo de Emergencia

1. **No bloqueo en el abordaje:** `POST /api/v1/asistencia/abordaje` y `fn_registrar_abordaje_atomico` no bloquean al menor por la existencia de una alerta judicial activa; el niño debe subir a salvo al vehículo.
2. **Bloqueo categórico en el desembarque:** si el documento digitado/escaneado del receptor coincide vía `documento_restringido_hash` con una alerta activa del estudiante, la entrega se rechaza incluso si el individuo figura en `estudiante_acudiente` o `estudiante_autorizado`. El menor permanece en `A_BORDO_VEHICULO`, `viaje.total_a_bordo` no se decrementa y no se crea registro en `entrega` ni `DESCENSO` en `registro_de_asistencia`.
3. **Acta de incidente automática:** se inserta un registro `CRITICO` en `incidente` con `tipo_incidente = 'ALERTA_JUDICIAL_DETECTADA'`, radicado, juzgado y coordenadas GPS.
4. **Protocolo de notificación de máxima prioridad (`ALERTA_JUDICIAL_ACTIVADA`):**
   - Despacha `SMS` de emergencia no silenciable (`silenciable = false`, `prioridad = 'MAXIMA'`) a los acudientes vinculados **cuyo `documento_blind_index` no coincida con el individuo restringido** (ej. la madre).
   - Activa el despacho institucional de alerta a la **Policía de Infancia y Adolescencia** (`NotificationsService.dispatchChildProtectionPoliceAlert`) y emite `coordination:judicial_alert` a Coordinación.
5. **Mitigación de falsos positivos por homonimia:** la coincidencia opera estrictamente sobre el HMAC-SHA256 del documento único de identidad normalizado (nunca por nombre) y acotada al `id_estudiante`.

---

## 5. Decisiones de Seguridad

- **Defensa en Profundidad (`OWASP ASVS V1.14`):** el bloqueo se aplica simultáneamente en la capa de aplicación (`JudicialAlertDeliveryInterceptor` + `DeliveryValidationService`), en el repositorio (`InMemoryAttendanceRepository` / `fn_registrar_descenso_atomico` en `V017`) y a nivel de tabla mediante trigger (`trg_bloquear_entrega_por_alerta_judicial` en `public.entrega`).
- **Fail-Safe (`RNF-01`):** ante cualquier error inesperado del motor o de la base de datos durante la verificación judicial, la cadena `DeliveryInterceptorChain` bloquea preventivamente la entrega y deja evidencia en `incidente` y `AuditService`.
- **Protección de PII en reposo y tránsito:** los datos de la orden judicial se almacenan cifrados con AES-256-GCM, las respuestas llevan `Cache-Control: no-store`, el listado enmascara el documento (`****3456`), `/verify` no devuelve PII descifrada y el documento plano no se escribe en logs ni en `AuditService`.
- **Soft-delete auditable:** las alertas nunca se borran físicamente; `PATCH /:alertId/deactivate` registra `eliminado_soft = true`, `eliminado_en`, `eliminado_por_coordinacion`, `autorizado_excepcion_por` y un evento forense encadenado SHA-256.

---

## 6. Cómo Probarlo

Pruebas unitarias, OCP, fail-safe y HTTP + RBAC + Socket.IO del Issue `#10`:

```bash
npx jest src/modules/custody/judicial-alerts/judicial-alerts.service.spec.ts src/modules/custody/judicial-alerts/judicial-alerts.http.spec.ts src/modules/attendance/judicial-alert-protection.spec.ts
```

Suite completa de pruebas del repositorio (regresión Issues `#1`–`#10`):

```bash
npm test
```

Integración real contra PostgreSQL 16 + PostGIS 3.4 (`V014`–`V017`, requiere contenedor `camino-seguro-postgres` con migraciones aplicadas y `RUN_POSTGRES_TESTS=true`):

```bash
npx jest src/modules/custody/judicial-alerts/infrastructure/postgres-judicial-alert.repository.integration.spec.ts src/modules/attendance/infrastructure/postgres-disembark.repository.integration.spec.ts src/modules/attendance/infrastructure/postgres-attendance.repository.integration.spec.ts src/modules/custody/infrastructure/postgres-custody.repository.integration.spec.ts --runInBand
```

*(Comprobado en esta rama: `npm run build` OK (`exit 0`); `npm test` 56 suites aprobadas, 5 omitidas sin BD activa, 409 pruebas aprobadas y 12 omitidas; suite de integración PostgreSQL 16 con `RUN_POSTGRES_TESTS=true` 4/4 suites y 9/9 pruebas aprobadas; ciclo reversible `V017` UP → `U017` DOWN → `V017` UP verificado sin errores sobre `camino-seguro-postgres`.)*
