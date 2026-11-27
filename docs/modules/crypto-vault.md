# Módulo de Criptovault, Blind Indexing y Expedientes (`CryptoModule` y `StudentsModule`)

- **Issue de referencia:** `#4` — *feat(students): criptovault de datos sensibles, expedientes y blind indexing HMAC* (cerrada).
- **Fuentes en el código:**
  - `src/common/crypto/` (`crypto.module.ts`, `aes-encryption.service.ts`, `blind-index.service.ts`, `crypto-vault.service.ts`, `hash.service.ts`)
  - `src/common/ports/crypto-vault.port.ts`
  - `src/common/security/pii-sanitizer.ts`, `src/common/security/sanitizing-logger.ts`
  - `src/modules/students/` (`students.module.ts`, `students.controller.ts`, `students.service.ts`, `students.permissions.ts`, `domain/student.entity.ts`, `domain/student.repository.ts`, `dto/student.dto.ts`, `infrastructure/in-memory-student.repository.ts`)
  - DDL asociado: `db/migrations/V001__init_extensions_and_roles.sql`, `V003__students_and_custody_vault.sql`, `V011__student_sensitive_fields.sql`

---

## 1. Propósito

Garantizar el cifrado autenticado en reposo de los datos personales y sensibles de salud de menores (**Ley Estatutaria 1581 de 2012**, **OWASP ASVS V6.2 / V6.4** y [ADR-002](../adr/ADR-002-inmutabilidad-criptografica-worm.md)) junto con búsquedas exactas por documento de identidad mediante **Blind Indexing determinista (HMAC-SHA256)** sin descifrar filas en base de datos ni exponer PII en logs o URLs.

---

## 2. Entidades, Contratos Criptográficos y Tablas

### Núcleo criptográfico transversal (`@Global() CryptoModule`)

| Servicio | Responsabilidad |
| --- | --- |
| `AesEncryptionService` | Cifrado y descifrado simétrico **AES-256-GCM** con IV aleatorio de 12 bytes (96 bits) y auth tag de 16 bytes (128 bits). Formato canónico: `key_version:iv_b64:tag_b64:ciphertext_b64`. |
| `BlindIndexService` | Generación determinista de índice ciego **HMAC-SHA256** (64 caracteres hex) con clave secreta independiente (`APP_BLIND_INDEX_HMAC_KEY`), normalizando `trim().toUpperCase()`. |
| `CryptoVaultService` | Fachada única que implementa `ICryptoVaultPort` (`encrypt`, `decrypt`, `encryptOptional`, `decryptOptional`, `generateBlindIndex`) y ejecuta `assertProductionKeys()` en el constructor. |
| `HashService` | Utilidades `sha256`, `sha256Buffer`, `chainHash` (WORM) y `hashPassword`/`verifyPassword` (PBKDF2-SHA512). |

### Tablas DDL y modelo de dominio de expedientes

- **`V001`:** dominio `formato_cifrado_aes` con regex `^v[0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$`.
- **`V003` + `V011` (`estudiante`):** `V011__student_sensitive_fields.sql` agrega `nombre_completo_cifrado`, `direccion_cifrada` y `condiciones_medicas_cifradas` (`formato_cifrado_aes`) y relaja `NOT NULL` en `nombres_cifrado` y `apellidos_cifrado`. `documento_cifrado` y `documento_blind_index` (único + índice B-Tree) provienen de `V003`.
- **Modelo en código (`StudentRecord`):** almacena únicamente campos cifrados (`nombre_completo_enc`, `documento_identidad_enc`, `direccion_enc`, `condiciones_medicas_enc`), `documento_blind_index`, `codigo_institucional`, `grado`, `id_colegio`, `activo`, `creado_en`.
- **Persistencia actual:** `StudentsModule` utiliza `InMemoryStudentRepository` (temporal en memoria, simula restricciones `UNIQUE` de `documento_blind_index` y `codigo_institucional`, y transacciones con staging/rollback).
- **Alcance actual frente a tablas de `V003`:** únicamente `estudiante` tiene entidad, repositorio, servicio y endpoints implementados en este módulo; las operaciones sobre `acudiente`, `adulto_autorizado` y la bóveda biométrica `expediente_cifrado` aún no cuentan con servicios/endpoints en `StudentsModule`.

---

## 3. Endpoints HTTP (`StudentsController`, prefijo `/api/v1/students`)

Todo el controlador exige:
- Autenticación Bearer (`JwtAuthGuard`),
- Rol `@Roles(RoleEnum.ADMIN, RoleEnum.RECTORIA)` (`RolesGuard`),
- Segundo factor verificado (`AppMfaGuard` + revalidación en servicio con `assertExpedienteAccess`),
- Cabecera de respuesta `Cache-Control: no-store`.

| Método y Ruta | Código | Entrada | Respuesta y comportamiento |
| --- | --- | --- | --- |
| `POST /api/v1/students` | `201` / `409` | `CreateStudentDto` (`id_colegio`, `codigo_institucional`, `nombre_completo`, `documento_identidad`, `direccion`, `condiciones_medicas?`, `grado`) | Cifra campos personales, calcula `documento_blind_index` y persiste `StudentRecord`. Devuelve `StudentExpediente` descifrado en memoria. `409` si documento o código ya existen. |
| `GET /api/v1/students` | `200` | Query `offset` (default `0`, `>= 0`) y `limit` (default `20`, `1`–`100`) | Devuelve `{ items: StudentSummary[], total, offset, limit }`. **Minimización:** `StudentSummary` omite documento, dirección y condiciones médicas. |
| `POST /api/v1/students/search` | `200` / `404` | `SearchStudentByDocumentDto` (`{ documento }`, patrón `/^[0-9A-Za-z][0-9A-Za-z.\- ]{4,24}$/`) | Calcula `blindIndex(documento)` y busca en `findByBlindIndex()`. Va por `POST` en cuerpo JSON para evitar PII en URLs, proxies y logs de acceso. |
| `GET /api/v1/students/:id` | `200` / `404` | `:id` validado con `ParseUUIDv7Pipe` | Recupera registro cifrado y devuelve `StudentExpediente` descifrado solo en memoria. |

---

## 4. Reglas de Negocio

- **Normalización de documento (`normalizeDocument`):** convierte a mayúsculas y elimina espacios, puntos y guiones (`/[\s.\-]/g`), de modo que `"1.088.123.456"`, `"1088 123 456"` y `"1088123456"` producen exactamente el mismo `documento_blind_index`.
- **Unicidad sin texto plano:** las colisiones de documento se validan exclusivamente sobre `documento_blind_index`, nunca comparando documentos en claro.
- **Trazabilidad forense sin PII:** cada operación (`EXPEDIENTE_CREADO`, `EXPEDIENTE_CONSULTADO`, `EXPEDIENTE_BUSQUEDA_DOCUMENTO`, `EXPEDIENTES_LISTADOS`) se registra en `AuditService` con `id_usuario`, `id_estudiante` y metadatos técnicos, sin datos personales.
- **Limitación actual de rotación de llaves:** `AesEncryptionService.encrypt()` antepone `CURRENT_KEY_VERSION` (por defecto `v1`), pero `decrypt()` descarta el prefijo de versión (`parts[0]`) y descifra siempre con `APP_ENCRYPTION_MASTER_KEY` vigente; aún no existe un keyring multi-versión en memoria.

---

## 5. Decisiones de Seguridad

- **Claves independientes y validación en producción (`ASVS V6.4`):** `CryptoVaultService` exige en `NODE_ENV=production` que `APP_ENCRYPTION_MASTER_KEY` y `APP_BLIND_INDEX_HMAC_KEY` estén definidas, no coincidan con los valores dummy por defecto y sean distintas entre sí. Si la clave Base64 no mide exactamente 32 bytes, `AesEncryptionService` y `BlindIndexService` derivan 32 bytes vía SHA-256.
- **Integridad autenticada (`ASVS V6.2`):** cualquier alteración de IV, auth tag o ciphertext provoca fallo de verificación GCM (`InternalServerErrorException`).
- **Defensa en profundidad en autorización:** además de los guards globales (`JwtAuthGuard`, `RolesGuard`, `AppMfaGuard`), `StudentsService` invoca `assertExpedienteAccess(actor)` antes de cifrar o descifrar datos.
- **Sanitización transversal de logs (`SanitizingLogger` + `pii-sanitizer.ts`):** `main.ts` instala `SanitizingLogger` globalmente, y tanto `LoggingInterceptor` como `AllExceptionsFilter` sanitizan URLs, mensajes y stack traces redactando claves sensibles (`documento`, `nombre`, `direccion`, `condicion`, `medic`, `email`, `token`, `secret`, etc.), textos cifrados AES, JWTs, cabeceras Bearer y números de 6 o más dígitos.
- **No almacenamiento en caché:** todos los endpoints de `/students` envían `Cache-Control: no-store`.

---

## 6. Cómo Probarlo

```bash
npx jest src/common/crypto src/common/security src/modules/students/students.service.spec.ts src/modules/students/students.http.spec.ts
```

*(Comprobado: 6 suites aprobadas, 52 pruebas aprobadas.)* Las pruebas cubren cifrado/descifrado AES-256-GCM, detección de manipulación del auth tag, determinismo de blind index, rechazo de llaves inseguras en producción, control RBAC/MFA en HTTP y ausencia de PII en logs de acceso y error.
