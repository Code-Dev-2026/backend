# Issue #3: feat(auth): módulo de identidad, autenticación JWT con rotación, RBAC y MFA
**Etiqueta:** requirement

### Contexto
El acceso al sistema gestiona información sumamente sensible de menores y operaciones de transporte escolar. La autenticación debe ser invulnerable a secuestro de sesiones, ataques de fuerza bruta y escalamiento de privilegios, cumpliendo estrictamente con OWASP ASVS L2.

### Objetivo
Implementar el módulo de autenticación de NestJS con hashing Argon2id (con fallback Bcrypt), emisión de Access Tokens JWT (15 min), rotación de Refresh Tokens con detección de reutilización (`family_id`), autorización granular RBAC y segundo factor de autenticación mediante código OTP (One-Time Password) para roles directivos y administrativos.

### Alcance
- **Incluye:** Endpoints `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/mfa/verify`; guards de NestJS (`JwtAuthGuard`, `RolesGuard`, `MfaGuard`); rotación con detección de robo en tabla `refresh_token`; almacenamiento de secretos y claves OTP cifradas con AES-256-GCM en `mfa_secret`.
- **No incluye:** Proveedores de identidad social (OAuth2 Google/Apple) no contemplados en el SRS v2.0.

### Requisitos SRS v2.0
- RF-01 (Usuarios y Roles), RF-13 (Matriz de Control de Acceso), RNF-01 (Seguridad en Autenticación), RNF-02 (Aislamiento de Sesión).
- Hashing de contraseñas con Argon2id (parámetros ASVS: m=64MB, t=3, p=4) y rotación de tokens con revocación de familia.

### Tablas Involucradas
- `usuario`, `rol`, `usuario_rol`, `refresh_token`, `mfa_secret`.

### Criterios de Aceptación
- **Dado** un usuario con rol directivo (`COORDINADORA_CONVIVENCIA` o `RECTORIA`) con credenciales válidas,
- **Cuando** envía su email y contraseña a `POST /api/v1/auth/login`,
- **Entonces** recibe un token provisional y un desafío OTP de 6 dígitos antes de obtener el Access Token definitivo.
- **Dado** un usuario que introduce el código OTP correcto emitido por el sistema,
- **Cuando** envía el código al endpoint `POST /api/v1/auth/mfa/verify`,
- **Entonces** se valida el código OTP, se marca la sesión como verificada y se emite el Access Token con permisos completos.
- **Dado** un atacante que intenta reusar un Refresh Token consumido previamente,
- **Cuando** invoca `POST /api/v1/auth/refresh`,
- **Entonces** el sistema revoca de inmediato toda la familia de tokens (`family_id`), bloquea la sesión y registra el incidente en la bitácora de auditoría.

### Tareas Técnicas
- [ ] Implementar `Argon2idPasswordHasher` bajo la interfaz abstracta `IPasswordHasher`.
- [ ] Implementar caso de uso `LoginUseCase` orquestando validación de estado y requerimiento de OTP.
- [ ] Implementar `RefreshTokenService` con hashing SHA-256 del token y control de concurrencia.
- [ ] Implementar `OtpMfaService` con generación y validación de códigos numéricos de un solo uso de 6 dígitos.
- [ ] Configurar decoradores `@Roles(...)`, `@CurrentUser()` y guards globales `RolesGuard` y `MfaGuard`.

### Principio SOLID Aplicado y Verificación
- **SRP (Single Responsibility):** Separación estricta entre validación de credenciales (`AuthService`), emisión de JWT (`TokenService`) y validación de códigos de un solo uso (`OtpMfaService`).
- **DIP (Dependency Inversion):** Los casos de uso dependen de abstracciones (`IUserRepository`, `ITokenRepository`) sin acoplamiento a TypeORM.

### Criterios de Seguridad
- OWASP ASVS V2.1 (Almacenamiento de credenciales con Argon2id), V3.2 (Tokens de sesión efímeros), V3.5 (Doble factor OTP obligatorio para administradores).

### Verificación Automática
- Pruebas unitarias de hashing, validación OTP y rotación de tokens (Jest); pruebas E2E contra endpoints protegidos simulando tokens expirados y códigos OTP inválidos.

### Dependencias
- **Depende de:** Issue #1 (Scaffold NestJS) e Issue #2 (Tablas de identidad en PostgreSQL).
- **Bloquea a:** Issues #7, #9, #12, #18 y #19.

### Definición de Hecho (DoD)
- Cobertura de pruebas unitarias > 90%, guardias RBAC operativas en endpoints y flujo de login con validación OTP funcionando en verde.

### Riesgos y Mitigaciones
- **Riesgo:** Bloqueo de directivas por caducidad o retardo en el código OTP.
- **Mitigación:** Ventana de expiración adecuada (ej. 5 minutos) y soporte de códigos de respaldo (backup codes) pregenerados.

### Estimación
- 5 Puntos de Historia (3 días).
