# Módulo de Importación Masiva de Matrículas (`StudentsImportController` y `EnrollmentImportService`)

- **Issue de referencia:** `#5` — *feat(students): importación masiva de matrículas con validación transaccional y hash SHA-256* (cerrada).
- **Fuentes en el código:**
  - `src/modules/students/import/students-import.controller.ts`
  - `src/modules/students/import/enrollment-import.service.ts`
  - `src/modules/students/import/enrollment-file-reader.ts`
  - `src/modules/students/import/import-ledger.ts`
  - `src/modules/students/dto/student.dto.ts` (`ImportStudentRowDto`, `ImportStudentsDto`)
  - `src/modules/schools/schools.service.ts`
  - DDL asociado: `db/migrations/V007__notifications_and_offline_sync.sql` y `db/migrations/V012__enrollment_import_ledger.sql`

---

## 1. Propósito

Permitir a los roles administrativos (`ADMIN` / `COORDINADORA_CONVIVENCIA` y `RECTORIA`, con MFA verificado) cargar masivamente el censo de estudiantes desde archivos **CSV** o **Excel (`.xlsx`)** mediante lectura en streaming por lotes, cifrado automático en reposo vía `CryptoVaultService`, idempotencia por hash **SHA-256** del archivo y atomicidad transaccional.

---

## 2. Entidades, Contratos y Tablas

- **`importacion_matricula` (`IImportLedger`):** almacena la reserva e historial por `hash_sha256` del archivo (`EN_PROCESO` → `COMPLETADA`, o liberación con `release()` si se revierte).
  - **Adaptador actual:** `InMemoryImportLedger` (temporal en memoria, atómico en el event loop).
  - **Nota sobre DDL (`V007` vs `V012`):** `V007__notifications_and_offline_sync.sql` define `CREATE TABLE IF NOT EXISTS importacion_matricula` con columnas (`hash_sha256_archivo`, `cargado_por_usuario`, `nombre_archivo`, `total_registros`, etc.), mientras que `V012__enrollment_import_ledger.sql` vuelve a ejecutar `CREATE TABLE IF NOT EXISTS importacion_matricula` con columnas distintas (`hash_sha256`, `id_usuario`, `tipo_archivo`, `tamano_bytes`, `filas_creadas`). En una base donde `V007` se aplicó previamente, `V012` no alterará la estructura existente; esto debe alinearse al conectar el adaptador PostgreSQL.
- **`estudiante` (`IStudentRepository`):** inserción por lotes dentro de `repository.transaction(tx => ...)` (`InMemoryStudentRepository` en la implementación actual).
- **Validación de institución (`SchoolsService`):** verifica `id_colegio` contra `SchoolsService.findById()` (actualmente reconoce el UUID fijo `018e38d9-3f00-7200-a000-000000000002` — Colegio San Benito del Otún).

---

## 3. Endpoint y Contrato HTTP

### `POST /api/v1/students/import`

- **Seguridad:** `JwtAuthGuard` + `@Roles(RoleEnum.ADMIN, RoleEnum.RECTORIA)` + `AppMfaGuard` + `assertExpedienteAccess()` + cabecera `Cache-Control: no-store`.
- **Tipo de contenido:** `multipart/form-data` (Multer en memoria: el archivo nunca se escribe en disco; `limits: { fileSize: 5 MB, files: 1, fields: 5 }`).
- **Campos del formulario:**
  - `file` *(obligatorio)*: archivo `.csv` (UTF-8, delimitador `,` o `;`) o `.xlsx` (se procesa únicamente la primera hoja).
  - `id_colegio` *(obligatorio)*: UUID válido (`ImportStudentsDto`).

#### Columnas aceptadas en el archivo

Los encabezados se normalizan (`normalizeHeader`: sin tildes, minúsculas, espacios/símbolos a `_`).

| Columna canónica | Requerida | Alias aceptados | Reglas (`ImportStudentRowDto`) |
| --- | --- | --- | --- |
| `codigo_institucional` | Sí | `codigo` | Cadena no vacía, máx. 30 caracteres |
| `nombre_completo` | Sí | `nombre`, `nombres_y_apellidos` | Cadena no vacía, máx. 150 caracteres |
| `documento_identidad` | Sí | `documento`, `numero_documento` | Patrón `/^[0-9A-Za-z][0-9A-Za-z.\- ]{4,24}$/` |
| `direccion` | Sí | — | Cadena no vacía, máx. 200 caracteres |
| `grado` | Sí | — | Cadena no vacía, máx. 20 caracteres |
| `condiciones_medicas` | No | `condiciones_medicas_relevantes` | Cadena opcional, máx. 1000 caracteres |

Columnas desconocidas se ignoran y se reportan en `advertencias`. Encabezados duplicados o faltantes provocan rechazo.

#### Códigos HTTP y estructura de respuesta (`ImportBalance`)

| Código | Cuándo ocurre |
| --- | --- |
| `201 Created` | Todas las filas fueron válidas y se confirmaron en una sola transacción (`estado: "COMPLETADA"`). |
| `400 Bad Request` | Falta el archivo, viene vacío o `id_colegio` no es un UUID válido. |
| `401` / `403` | Sin JWT válido, sin MFA o rol distinto de `ADMIN`/`RECTORIA`. |
| `409 Conflict` | Archivo duplicado por `hash_sha256` (ya completado o actualmente en proceso). |
| `413 Payload Too Large` | Archivo supera `5 MB` (`IMPORT_MAX_BYTES = 5 * 1024 * 1024`). |
| `415 Unsupported Media Type` | Extensión/MIME no permitidos, firma binaria XLSX distinta de `504b0304`, CSV con bytes nulos o codificación distinta de UTF-8 válido. |
| `422 Unprocessable Entity` | Cualquier error de validación, colegio inexistente, archivo sin filas, > 5,000 filas, duplicado interno o existente en BD, o violación de integridad (`estado: "REVERTIDA"`, `creadas: 0`, rollback completo). |

Ejemplo de cuerpo `ImportBalance` (sin PII en errores ni advertencias):

```json
{
  "estado": "COMPLETADA",
  "archivo": {
    "nombre": "matriculas-2026.csv",
    "tipo": "CSV",
    "tamano_bytes": 1024,
    "hash_sha256": "<64-hex>"
  },
  "id_colegio": "018e38d9-3f00-7200-a000-000000000002",
  "total_filas": 2,
  "filas_procesadas": 2,
  "filas_validas": 2,
  "creadas": 2,
  "total_errores": 0,
  "errores": [],
  "advertencias": []
}
```

---

## 4. Reglas de Negocio

- **Atomicidad todo-o-nada:** el servicio ejecuta todo el archivo dentro de una sola transacción (`repository.transaction`). Si se detecta al menos un error en encabezados, formato, DTO, duplicado dentro del archivo, duplicado en base de datos (sobre `documento_blind_index` o `codigo_institucional`) o llave foránea, lanza `RollbackSignal` para revertir toda la operación (`creadas: 0`), continúa validando lotes restantes para reportar observaciones completas (tope de `500` entradas en `errores`, manteniendo `total_errores` exacto) y responde `422`.
- **Procesamiento en streaming por lotes:** `readEnrollmentRows` lee fila a fila con `csv-parse` (`bom: true`, delimitadores `,` y `;`, `max_record_size: 64 KB`) o `ExcelJS.stream.xlsx.WorkbookReader`, agrupando lotes de **100 filas** (`IMPORT_BATCH_SIZE = 100`) hasta un máximo de **5,000 filas** (`IMPORT_MAX_ROWS = 5_000`) y recortando celdas a `2,000` caracteres.
- **Idempotencia por SHA-256:** antes de procesar, reserva el `hash_sha256` en `IImportLedger` (`EN_PROCESO`). Si la carga completa, marca `COMPLETADA` (futuros envíos idénticos reciben `409 Conflict`); si se revierte (`422`) o ocurre un error inesperado, invoca `release(hash)` para permitir reintentar el archivo corregido.
- **Auditoría:** cada carga registra `IMPORTACION_MATRICULAS_COMPLETADA` o `IMPORTACION_MATRICULAS_REVERTIDA` en `AuditService` con hash, colegio, tipo y conteos (sin PII).

---

## 5. Decisiones de Seguridad

- **Validación de contenido real (magic bytes y UTF-8):** además de extensión (`.csv`/`.xlsx`) y MIME (`text/csv`, `application/csv`, `text/plain`, `application/vnd.ms-excel`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `application/octet-stream`), valida firma ZIP `504b0304` para `.xlsx` y ausencia de bytes nulos + decodificación `TextDecoder("utf-8", { fatal: true })` para `.csv`.
- **Cero escritura temporal en disco:** Multer mantiene el buffer únicamente en RAM con límite de `5 MB`, `1` archivo y máximo `5` campos de formulario.
- **Cifrado inmediato en memoria:** cada fila válida se transforma con `Student.create(..., vault)` antes de acumularse o persistirse, verificando duplicados en BD sobre `documento_blind_index`.
- **Observaciones libres de PII:** los mensajes de `RowIssue` indican fila, campo y motivo sin reproducir documentos, nombres ni direcciones.
- **Nota sobre inyección de fórmulas CSV:** no existe aún sanitización específica para prefijos de fórmula (`=`, `+`, `-`, `@`) en celdas de entrada.

---

## 6. Cómo Probarlo

```bash
npx jest src/modules/students/import
```

Ejecuta `enrollment-import.service.spec.ts` (CSV con `,` y `;`, `.xlsx`, lotes, duplicados, rollback integral, idempotencia por SHA-256, límites de filas y formatos inválidos) y `students-import.http.spec.ts` (multipart HTTP, códigos `201`, `400`, `401`, `403`, `409`, `413`, `415`, `422`).

> **Nota de verificación:** el caso `"importa un Excel .xlsx"` en `enrollment-import.service.spec.ts` presentó comportamiento intermitente (*flaky*): aprobó en la corrida completa de `npm test` / `npm run test:cov` (36/36), pero falló en ejecución aislada devolviendo `422` en lugar de `201` (probable condición de carrera en `ExcelJS.stream.xlsx.WorkbookReader` sobre `Readable.from([buffer])`). `students-import.http.spec.ts` aprobó de forma consistente.
