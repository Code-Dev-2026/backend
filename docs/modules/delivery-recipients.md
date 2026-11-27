# Módulo de Receptores de Entrega, Desembarque Seguro y Retorno a Sede (`AttendanceModule`)

- **Issue de referencia:** `#9` — *feat(custody): validación de receptores de entrega, desembarque seguro y retorno a sede* (cerrada).
- **Fuentes en el código:**
  - `src/modules/attendance/` (`attendance.controller.ts`, `delivery-validation.service.ts`, `disembark.use-case.ts`, `incident-logger.service.ts`, `boarding-notification-queue.service.ts`, `domain/disembark.types.ts`, `dto/register-disembark.dto.ts`, `infrastructure/attendance-realtime.gateway.ts`, `infrastructure/postgres-attendance.repository.ts`, `infrastructure/in-memory-attendance.repository.ts`)
  - DDL asociado: `db/migrations/V003__students_and_custody_vault.sql`, `V006__attendance_and_custody_lifecycle.sql`, `db/migrations/V016__atomic_disembark_and_safe_return.sql` y `db/migrations/undo/U016__atomic_disembark_and_safe_return.sql`

---

## 1. Propósito

Garantizar que cada menor sea entregado exclusivamente a su **acudiente titular**, a un **adulto autorizado activo y vigente** (máximo 3 activos por estudiante, `RN-04`) o a la **sede educativa** en recorridos de mañana, verificando la identidad contra `documento_blind_index` (HMAC-SHA256) y alertas judiciales activas; y ejecutar el **protocolo de retorno seguro a sede escolar (`RF-11`)** sin decrementar `total_a_bordo` hasta certificar la recepción formal con `acta_custodia` firmada en Coordinación/Rectoría.

---

## 2. Entidades, Servicios SRP y Tablas

### Separación SRP

- **`DeliveryValidationService`:** verifica exclusivamente la potestad del receptor (`validateReceptorForDelivery`) y la pertenencia institucional del coordinador (`validateSchoolCoordinator`) bajo principio **fail-safe**.
- **`DisembarkUseCase`:** orquesta validación, transacción atómica de desembarque/retorno/cierre en sede, registro de incidentes, eventos Socket.IO y notificaciones a todos los acudientes vinculados.

### Tablas y Funciones PostgreSQL (`V003`, `V006`, `V016`)

- **Tablas involucradas:** `viaje`, `viaje_estudiante`, `entrega`, `registro_de_asistencia`, `acta_custodia`, `estudiante_acudiente`, `estudiante_autorizado`, `adulto_autorizado`, `expediente_cifrado`, `alerta_judicial`, `coordinador`, `incidente`, `historial_estado_custodia`, `notificacion`.
- **Cambios DDL en `V016__atomic_disembark_and_safe_return.sql`:**
  1. Amplía los `CHECK` de `entrega` para soportar `tipo_receptor IN ('ACUDIENTE', 'AUTORIZADO', 'ADULTO_AUTORIZADO', 'SEDE_EDUCATIVA', 'RETORNO_SEDE_ESCOLAR')` manteniendo compatibilidad con `V006`.
  2. Agrega columna `idempotency_key` + índice único parcial `uq_entrega_idempotency_key` en `entrega`.
  3. Actualiza `fn_bloquear_cierre_viaje_con_menores_a_bordo()` para bloquear `FINALIZADO` mientras existan estudiantes en `A_BORDO_VEHICULO` **o** `RETORNO_SEDE_POR_FALLA_ENTREGA`.
  4. Crea `fn_registrar_descenso_atomico(...)` y `fn_finalizar_custodia_sede_atomico(...)` (con generación de `acta_custodia.firma_digital_hash` vía `SHA-256` y transición FSM WORM a `EN_COLEGIO`).
  5. Otorga `GRANT SELECT ON public.acudiente` a `app_user_operations` y `GRANT EXECUTE` sobre ambas funciones a `app_user` y `app_user_operations`.

---

## 3. Endpoints HTTP y Eventos Socket.IO

### `POST /api/v1/asistencia/descenso` (`200 OK`)

- **Seguridad:** JWT + `@Roles(MONITORA, ADMIN, COORDINADORA_CONVIVENCIA, JEFE_OPERACIONES)` + cabecera opcional `X-Idempotency-Key`.
- **Cuerpo (`RegisterDisembarkDto`):**
  - `id_viaje` (UUID), `id_estudiante` (UUID individual), `coordenadas_gps` (`{ latitud, longitud }` WGS84) — obligatorios.
  - `resultado_entrega`: `ENTREGADO_EXITOSO` (default) | `DESEMBARQUE_FALLIDO_RETORNO`.
  - `tipo_receptor` *(obligatorio si `ENTREGADO_EXITOSO`)*: `ACUDIENTE` | `ADULTO_AUTORIZADO` | `SEDE_EDUCATIVA`.
  - `documento_receptor` (en claro, se normaliza y convierte a blind index en memoria) y/o `documento_blind_index` (64 hex) y/o `id_receptor` (UUID opcional para doble cotejo).
  - `metodo_validacion`: `VERIFICACION_VISUAL_PARADA` (default) | `QR_INSTITUCIONAL` | `QR_OCASIONAL_TEMPORAL`.
  - `foto_evidencia_url`, `observaciones_fallido`, `sincronizado_offline`, `idempotency_key` (opcionales).

#### Comportamiento por resultado (`DisembarkResponse`)

| `resultado_entrega` | Código devuelto | Efecto en `total_a_bordo`, tablas, FSM y alertas |
| --- | --- | --- |
| `ENTREGADO_EXITOSO` | `DESCENSO_EXITOSO` (`aprobado: true`) | Decrementa `total_a_bordo - 1`; inserta fila en `entrega` y `registro_de_asistencia` (`DESCENSO`); transiciona FSM WORM a `EN_COLEGIO` (`MANANA`) o `ENTREGADO_ACUDIENTE` (`TARDE`); emite WS `student:disembarked` y push a todos los acudientes. |
| `DESEMBARQUE_FALLIDO_RETORNO` | `DESEMBARQUE_FALLIDO_RETORNO` (`aprobado: false`) | **NO decrementa `total_a_bordo`**; inserta fila en `entrega` (`tipo_receptor: RETORNO_SEDE_ESCOLAR`); NO inserta `DESCENSO` en `registro_de_asistencia`; transiciona FSM WORM a `RETORNO_SEDE_POR_FALLA_ENTREGA`; crea incidente `CRITICO`, emite WS `coordination:failed_delivery_alert` y encola alerta `EMERGENCIA` a todos los acudientes. |

#### Códigos de error HTTP en `/asistencia/descenso`

- `400`: DTO inválido, falta `tipo_receptor` en entrega exitosa o coordenadas WGS84 inválidas.
- `401` / `403`: sin JWT, rol no autorizado, **alerta judicial bloqueante** (`ALERTA_JUDICIAL_BLOQUEANTE` + incidente `CRITICO` + SMS `ALERTA_JUDICIAL_ACTIVADA` a acudientes no restringidos + alerta a Coordinación y Policía de Infancia y Adolescencia; ver [judicial-alerts.md](judicial-alerts.md)), receptor no acreditado, inactivo/revocado o autorización vencida (`INCIDENTE` + alerta WS `coordination:unauthorized_receptor_alert`).
- `404`: viaje o estudiante no encontrado.
- `409`: viaje no `EN_CURSO` o descenso previo ya registrado (`DuplicateDisembarkError`).
- `422`: estudiante no `A_BORDO_VEHICULO`, recorrido incompatible (`SEDE_EDUCATIVA` en `TARDE` o `ACUDIENTE`/`ADULTO_AUTORIZADO` en `MANANA`), o anomalía `RN-04` (`> 3` autorizados activos).
- `503`: fallo técnico del motor preventivo de alertas judiciales (`MOTOR_JUDICIAL_NO_DISPONIBLE_BLOQUEO_SEGURO`, bloqueo fail-safe manteniendo al menor a bordo).

### `POST /api/v1/asistencia/custodia/finalizar-sede` (`200 OK`)

Cierra formalmente la custodia de un estudiante en estado `RETORNO_SEDE_POR_FALLA_ENTREGA` al llegar a la sede escolar.

- **Seguridad (separación de funciones):** JWT + `@Roles(COORDINADORA_CONVIVENCIA, RECTORIA, ADMIN, JEFE_OPERACIONES)`. El rol `MONITORA` queda **excluido (`403 Forbidden`)**.
- **Cuerpo (`FinalizeSchoolCustodyDto`):** `id_viaje`, `id_estudiante`, `recibido_por_coordinador` (UUID de `coordinador`), `coordenadas_gps`, y opcionales `observaciones`, `idempotency_key` (o cabecera `X-Idempotency-Key`).
- **Efecto (`CUSTODIA_SEDE_FINALIZADA`):**
  1. Valida que el coordinador pertenezca al mismo colegio del estudiante (`403` si no).
  2. Exige estado `RETORNO_SEDE_POR_FALLA_ENTREGA` (`422` si no) y entrega fallida previa sin acta (`409` si falta o ya tiene acta).
  3. **Decrementa `total_a_bordo - 1`**, registra `registro_de_asistencia` (`DESCENSO`), crea `acta_custodia` con `firma_digital_hash` SHA-256 no repudiable y transiciona la FSM WORM a `EN_COLEGIO`.
  4. Emite WS `custody:school_return_completed` y notifica a los acudientes.

### Eventos Socket.IO (namespace `/asistencia`)

- `student:disembarked` (entrega exitosa) y `custody:school_return_completed` (acta en sede): emitidos al namespace `/asistencia`.
- `coordination:failed_delivery_alert`, `coordination:unauthorized_receptor_alert` y `coordination:judicial_alert`: emitidos a la sala `coordinacion`.

---

## 4. Reglas de Negocio

- **Validación independiente por estudiante:** ante hermanos o estudiantes emparentados retirados por el mismo adulto, cada estudiante se valida de forma aislada contra su propio directorio (`id_estudiante`) y genera su propia fila en `entrega`.
- **Regla `RN-04` (máximo 3 adultos autorizados activos):** `DeliveryValidationService` cuenta los autorizados vigentes no revocados y bloquea de forma segura (`422`) si por anomalía de datos supera 3, complementando el trigger `trg_limite_autorizados` de `V003`.
- **Invariante de retorno seguro (`RF-11`):** durante `RETORNO_SEDE_POR_FALLA_ENTREGA`, el estudiante sigue contado en `total_a_bordo` y bloquea el cierre del viaje (`PATCH /api/v1/trips/:id/finish` → `409 Conflict`) hasta que Coordinación/Rectoría ejecute `POST /api/v1/asistencia/custodia/finalizar-sede`.
- **Idempotencia en entregas:** si llega una petición repetida con el mismo `idempotency_key`, devuelve el resultado original con `duplicado_por_idempotencia: true` sin decrementar nuevamente el aforo ni duplicar alertas/notificaciones.

---

## 5. Decisiones de Seguridad

- **Cotejo exclusivo por Blind Index (`OWASP ASVS V4.1`):** `DeliveryValidationService.resolveBlindIndex()` normaliza el documento y calcula HMAC-SHA256 con `CryptoVaultService`/`BlindIndexService`. Si el cliente envía simultáneamente `documento_receptor` y `documento_blind_index`, ambos deben coincidir exactamente o la entrega se rechaza.
- **Prioridad absoluta de alertas judiciales (`RF-02`, `RF-09`, `RNF-01`):** antes de comprobar si el individuo figura como acudiente o autorizado, la cadena OCP `DeliveryInterceptorChain` (`JudicialAlertDeliveryInterceptor`) y `fn_registrar_descenso_atomico` (`V017`) contrastan su blind index contra `alerta_judicial.documento_restringido_hash` (`activa = TRUE` y `eliminado_soft = FALSE`); cualquier coincidencia bloquea con `403 Forbidden` (`ALERTA_JUDICIAL_BLOQUEANTE`), registra incidente `CRITICO`, despacha SMS `ALERTA_JUDICIAL_ACTIVADA` a acudientes no restringidos y alerta a Coordinación y Policía de Infancia y Adolescencia (ver [judicial-alerts.md](judicial-alerts.md)).
- **Separación de funciones:** la monitora registra el retorno fallido, pero solo directivas/operaciones (`COORDINADORA_CONVIVENCIA`, `RECTORIA`, `ADMIN`, `JEFE_OPERACIONES`) pueden firmar el cierre en sede y liberar el cupo.
- **No repudio del acta:** `firma_digital_hash = SHA-256(id_entrega | id_estudiante | recibido_por_coordinador | fecha_utc_iso | observaciones)`.

---

## 6. Cómo Probarlo

```bash
npx jest src/modules/attendance/delivery-validation.service.spec.ts src/modules/attendance/disembark.use-case.spec.ts src/modules/attendance/disembark.http.spec.ts
```

O ejecutando toda la suite del módulo:

```bash
npx jest src/modules/attendance
```

*(Comprobado sobre `src/modules/attendance`: 5 suites aprobadas —incluyendo `delivery-validation.service.spec.ts`, `disembark.use-case.spec.ts` y `disembark.http.spec.ts` con RBAC, separación de funciones en `/finalizar-sede`, bloqueo de cierre `409`, retorno a sede y Socket.IO—, 2 suites de integración PostgreSQL omitidas sin BD activa; 29 pruebas aprobadas, 5 omitidas.)*
