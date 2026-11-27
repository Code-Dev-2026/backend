# Módulo de Autenticación, RBAC y MFA (`AuthModule`)

- **Issue de referencia:** `#3` — *feat(auth): módulo de identidad, autenticación JWT con rotación, RBAC y MFA* (cerrada).
- **Fuentes en el código:**
  - `src/modules/auth/` (`auth.module.ts`, `auth.controller.ts`, `auth.service.ts`, `token.service.ts`, `refresh-token.service.ts`, `email-otp.service.ts`, `otp-mfa.service.ts`, `session.service.ts`, `users.service.ts`, `use-cases/*`, `guards/*`, `domain/*`, `dto/*`, `infrastructure/*`)
  - `src/modules/mailer/mailer.service.ts`
  - `src/common/guards/roles.guard.ts`, `src/common/guards/mfa.guard.ts`, `src/common/enums/role.enum.ts`, `src/common/decorators/*`
  - DDL asociado: `db/migrations/V002__identity_and_access.sql`

---

## 1. Propósito

Proveer el control centralizado de identidad, sesiones efímeras JWT, rotación de Refresh Tokens con detección de reutilización (`family_id`), segundo factor de autenticación (OTP) y autorización basada en roles (RBAC) para toda la API HTTP bajo directrices **OWASP ASVS L2**.

---

## 2. Entidades, Modelos y Tablas

### Tablas DDL (`V002__identity_and_access.sql`)

| Tabla | Rol en el módulo |
| --- | --- |
| `usuario` | Credenciales (`email` único, `password_hash` Argon2id), `estado` (`ACTIVO`, `INACTIVO`, `BLOQUEADO`), `mfa_habilitado`, `ultimo_ingreso`. |
| `rol` | Catálogo de los 8 roles oficiales (`COORDINADORA_CONVIVENCIA`, `RECTORIA`, `GERENCIA_TRANSPORTE`, `JEFE_OPERACIONES`, `ADMINISTRADOR_CARTERA`, `MONITORA`, `CONDUCTOR`, `ACUDIENTE`). |
| `usuario_rol` | Relación N:M entre usuarios y roles. |
| `refresh_token` | Sesiones renovables agrupadas por `family_id`, almacenando solo `token_hash` (SHA-256), bandera `revocado` y `expira_en`. |
| `mfa_secret` | Bóveda prevista para secreto TOTP cifrado (`formato_cifrado_aes`) y `backup_codes_hashes` (usada por `OtpMfaService`, actualmente no cableado en `AuthModule`). |

### Modelos de dominio y adaptadores actuales (`src/modules/auth/`)

- **Entidad/modelos:** `User` (`user.entity.ts`), `UserRecord`, `RefreshTokenRecord`, `EmailOtpRecord`, `MfaSecretRecord` (`auth.models.ts`).
- **Puertos:** `IUserRepository`, `ITokenRepository`, `IEmailOtpRepository`, `IMfaRepository`, `IPasswordHasher`, `ISecurityAuditPort`.
- **Persistencia actual:** `AuthModule` inyecta **adaptadores temporales en memoria** (`InMemoryUserRepository` —arranca vacío sin usuarios por defecto—, `InMemoryTokenRepository`, `InMemoryEmailOtpRepository`) junto con `Argon2idPasswordHasher` y `AuditLedgerSecurityAudit` (conectado a `AuditService`).

---

## 3. Endpoints y Contratos HTTP

Todos los endpoints de `AuthController` (`@Controller("auth")`) están decorados con `@Public()` porque validan credenciales, token provisional o refresh token por sí mismos.

### `POST /api/v1/auth/login` (`200 OK`)

Paso 1 de autenticación (aplica a **todos los roles**).

- **Cuerpo (`LoginDto`):**
  - `email`: correo electrónico válido (obligatorio).
  - `password`: cadena de al menos 8 caracteres (obligatoria).
- **Respuesta (`LoginResult`):**
  ```json
  {
    "requiresMfa": true,
    "mfaToken": "<jwt-provisional-5m>",
    "mfaChallenge": {
      "type": "EMAIL_OTP",
      "digits": 6,
      "destination": "co***@sanbenito.edu.co"
    },
    "expiresIn": 300
  }
  ```
- **Errores:** `400` (DTO inválido), `401` (credenciales inválidas o usuario no `ACTIVO`), `503` (fallo de envío SMTP; el desafío se elimina automáticamente).

### `POST /api/v1/auth/verify-otp` (`200 OK`)

Paso 2 de autenticación: verifica el OTP enviado por correo y abre la sesión definitiva.

- **Cuerpo (`VerifyOtpDto`):**
  - `mfaToken`: JWT provisional recibido en `/auth/login` (máx. 2048 chars).
  - `code`: código numérico exacto de 6 dígitos (`/^\d{6}$/`).
- **Respuesta (`AuthSession`):**
  ```json
  {
    "accessToken": "<jwt-access-15m>",
    "refreshToken": "<token-base64url-48-bytes>",
    "expiresIn": 900,
    "user": {
      "id_usuario": "<uuidv7>",
      "email": "coordinacion@sanbenito.edu.co",
      "roles": ["COORDINADORA_CONVIVENCIA"]
    }
  }
  ```
- **Errores:** `400` (DTO inválido), `401` (token provisional inválido/expirado/tipo incorrecto, usuario inactivo o código OTP inválido/expirado/agotado).

### `POST /api/v1/auth/refresh` (`200 OK`)

Rota el Refresh Token vigente y emite un nuevo par de tokens dentro de la misma `family_id`.

- **Cuerpo (`RefreshTokenDto`):** `refreshToken` (cadena no vacía, máx. 512 chars).
- **Respuesta (`RefreshResult`):** `{ accessToken, refreshToken, expiresIn: 900 }`.
- **Errores:** `400` (cuerpo inválido), `401` (token desconocido, expirado, usuario no `ACTIVO` o reutilización detectada con revocación completa de la familia).

### Guards globales (`APP_GUARD` en `AuthModule`)

Registrados en orden estricto para todo contexto HTTP:

1. **`JwtAuthGuard`:** omite contextos no-HTTP y rutas `@Public()`; exige `Authorization: Bearer <token>` con `typ === "access"` y algoritmo `HS256`, adjuntando `request.user` (`AuthenticatedUser`).
2. **`RolesGuard`:** lee `@Roles(...)`; valida usando `userHasAnyRole()` y el mapa `ROLE_EQUIVALENCES` (`role.enum.ts`), que enlaza roles de BD (ej. `COORDINADORA_CONVIVENCIA`, `MONITORA`, `ACUDIENTE`) con alias RBAC (`ADMIN`, `SUPER_ADMIN`, `SCHOOL_COORDINATOR`, `TRANSPORT_ADMIN`, `MONITOR`, `DRIVER`, `PARENT`).
3. **`AppMfaGuard`:** extiende `MfaGuard` omitiendo `@Public()` y contextos no-HTTP; bloquea con `401` si un usuario con rol `COORDINADORA_CONVIVENCIA`, `RECTORIA`, `SUPER_ADMIN` o `SCHOOL_COORDINATOR` no trae `mfa_autenticado: true` en el JWT.

---

## 4. Reglas de Negocio

- **Login en dos pasos para todos los roles:** `LoginUseCase` nunca entrega `accessToken` ni `refreshToken` en el paso 1; siempre emite un desafío `EMAIL_OTP` de 6 dígitos con vigencia estricta de **300 segundos** (`EMAIL_OTP_TTL_SECONDS`) y un JWT provisional (`typ: "mfa_challenge"`, claim `cid`, TTL `5m`).
- **Exclusividad de sesión:** al completar `verify-otp`, `SessionService.open()` invoca `revokeAllForUser()` para invalidar sesiones previas del usuario y actualiza `ultimo_ingreso`.
- **Un solo uso y tope de intentos en OTP:** un nuevo login reemplaza el desafío anterior del usuario (`replaceForUser`); el código se invalida y elimina tras **5 intentos fallidos** (`EMAIL_OTP_MAX_ATTEMPTS`) o al consumirse exitosamente.
- **Rotación antirrobo de Refresh Tokens:** cada uso de `/auth/refresh` marca el token anterior como revocado y emite uno nuevo con el mismo `family_id`. Presentar un token ya revocado dispara `revokeFamily(family_id)` y registra el incidente `REFRESH_TOKEN_REUSE_DETECTED`.
- **Alta de usuarios (`UsersService`):** normaliza el email a minúsculas, rechaza duplicados con `409 Conflict` y genera UUIDv7 con `uuidv7()`.
- **Nota sobre `OtpMfaService` (TOTP):** existe implementado en `src/modules/auth/otp-mfa.service.ts` (TOTP SHA-1 de 6 dígitos, secreto cifrado AES-256-GCM y 8 códigos de respaldo SHA-256), pero **no está registrado** en `AuthModule` porque el flujo activo utiliza `EmailOtpService`.

---

## 5. Decisiones de Seguridad

- **Hashing de contraseñas (`ASVS V2.1`):** `Argon2idPasswordHasher` usa Argon2id con `memoryCost = 65536 KiB (64 MB)`, `timeCost = 3`, `parallelism = 4`, y fallback automático a Bcrypt (`12` rondas) si el binding nativo no está disponible. Verifica ambos formatos (`$argon2*` y `$2*`).
- **Anti-enumeración (`ASVS V2.2`):** `AuthService.validateCredentials()` devuelve siempre `"Credenciales inválidas."` y ejecuta una verificación contra un *dummy hash* cuando el correo no existe para homogeneizar tiempos de respuesta.
- **Tokens efímeros y separación de propósito (`ASVS V3.2`):** Access Token fijo en `15m` (`900s`) con claim `typ: "access"` y token provisional en `5m` con `typ: "mfa_challenge"` y `cid`, verificados explícitamente con `algorithms: ["HS256"]` (rechaza intercambio de tipos de token).
- **Almacenamiento seguro de secretos efímeros:** los Refresh Tokens se guardan solo como `SHA-256` (`48` bytes CSPRNG); los OTP de correo solo como `SHA-256(id_desafio:code)` comparados con `crypto.timingSafeEqual`.
- **Guardia de secretos en producción:**
  - `AuthModule` falla al arranque si `NODE_ENV=production` y `JWT_SECRET` mantiene el valor de desarrollo o mide menos de 32 caracteres.
  - `MailerModule` falla al arranque en `production` si `SMTP_HOST` no está configurado; en desarrollo sin `SMTP_HOST`, `LogMailTransport` escribe el OTP en el log bajo el contexto exento `MailerService:dev` (`disableFileAccess: true` y `disableUrlAccess: true` en Nodemailer).
- **Auditoría de incidentes:** registra `LOGIN_FAILED`, `LOGIN_OTP_SENT`, `MFA_VERIFY`, `MFA_VERIFY_FAILED` y `REFRESH_TOKEN_REUSE_DETECTED` vía `ISecurityAuditPort`.

---

## 6. Cómo Probarlo

### Pruebas unitarias y HTTP (Jest)

```bash
npx jest src/modules/auth src/modules/mailer src/common/guards
```

*(Comprobado: 18 suites aprobadas, 136 pruebas aprobadas. Nota: la suite `test/auth.e2e-spec.ts` ejecutada con `npm run test:e2e` falla actualmente 17/17 porque intenta resolver `OtpMfaService`, proveedor que ya no está registrado en `AuthModule`.)*
