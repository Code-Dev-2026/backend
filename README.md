# Camino Seguro — Backend Core API

Backend del sistema **Camino Seguro**, plataforma de control de custodia física y digital de menores en el transporte escolar del **Colegio San Benito del Otún** (Pereira, Risaralda).

Construido con **NestJS 10**, **TypeScript (modo estricto)** y **PostgreSQL 16 + PostGIS 3.4**, bajo **Arquitectura Hexagonal (Ports & Adapters)**, **Clean Architecture**, controles **OWASP ASVS L2** y cumplimiento de la **Ley Estatutaria 1581 de 2012** (Habeas Data).

> Alcance actual de esta documentación: **Issues #1 a #9** (Sprints 0, 1 y 2). Los issues #10 en adelante se encuentran fuera del alcance de esta guía y se documentarán conforme se integren.

---

## Requisitos Previos

- **Node.js**: v20.x o superior *(verificado en v24.13.1)*
- **npm**: v10.x o superior *(verificado en v11.8.0)*
- **Git**: v2.40+ con extensión **git-flow**
- **Base de datos** *(una de las dos opciones)*:
  - **Docker + Docker Compose** (recomendado, usa la imagen `postgis/postgis:16-3.4` definida en `db/docker-compose.yml`), o
  - **PostgreSQL 16** con extensiones `postgis` (3.4), `pgcrypto` y `btree_gist`, más cliente `psql`.

---

## Instalación desde Cero

### 1. Clonar el repositorio

```bash
git clone https://github.com/Code-Dev-2026/backend.git
cd backend
```

### 2. Instalar dependencias

```bash
npm install
```

### 3. Configurar variables de entorno

Copia las plantillas de entorno para la aplicación y para la base de datos (nunca confirmes archivos `.env` en Git):

```bash
cp .env.example .env
cp db/.env.example db/.env
```

Completa las credenciales locales en `db/.env` (por ejemplo `POSTGRES_PASSWORD`, `APP_USER_PASSWORD`, `APP_USER_OPERATIONS_PASSWORD` y `APP_USER_BILLING_PASSWORD`) y ajusta `.env` para que coincida con tu entorno local.

#### Variables de entorno de la aplicación

La validación al arranque se ejecuta con Joi en `src/config/env.validation.ts`.

| Variable | En `.env.example` | Valor por defecto (`env.validation.ts`) | Propósito |
| --- | --- | --- | --- |
| `NODE_ENV` | Sí | `development` | Entorno (`development`, `production`, `test`) |
| `PORT` | Sí | `3000` | Puerto HTTP del servidor NestJS |
| `API_PREFIX` | Sí | `api/v1` | Prefijo global de rutas REST y Swagger |
| `CORS_ALLOWED_ORIGINS` | Sí | `http://localhost:3000,http://localhost:5173` | Orígenes permitidos por CORS (separados por coma) |
| `DB_HOST` | Sí | `localhost` | Host de PostgreSQL 16 + PostGIS |
| `DB_PORT` | Sí | `5432` | Puerto de PostgreSQL |
| `DB_NAME` | Sí | `camino_seguro_db` | Nombre de la base de datos |
| `DB_USER` | Sí | `app_user` | Rol operativo de conexión sin permisos DDL |
| `DB_PASSWORD` | Sí | *(definido para desarrollo)* | Contraseña del rol operativo (sustituir en despliegues reales) |
| `GEO_USE_POSTGIS` | No *(pendiente en `.env.example`)* | `false` | Activa el repositorio PostGIS en `RoutesModule` (`true`/`false`) |
| `CUSTODY_USE_POSTGRES` | Sí | `false` | Activa el repositorio PostgreSQL en `CustodyModule` (`true`/`false`) |
| `ATTENDANCE_USE_POSTGRES` | No *(pendiente en `.env.example`)* | `false` | Activa el repositorio PostgreSQL en `AttendanceModule` (`true`/`false`) |
| `QR_DYNAMIC_HMAC_SECRET` | No *(pendiente en `.env.example`)* | *(valor de desarrollo)* | Secreto HMAC para tokens QR dinámicos |
| `QR_DYNAMIC_TTL_SECONDS` | No *(pendiente en `.env.example`)* | `300` | Vigencia del QR dinámico en segundos (`30` a `86400`) |
| `CUSTODY_MORNING_JOB_ENABLED` | Sí | `false` | Habilita el job matutino de inicialización de custodia |
| `CUSTODY_MORNING_JOB_HOUR` | Sí | `5` | Hora de ejecución del job matutino (`0`–`23`) |
| `CUSTODY_MORNING_JOB_MINUTE` | Sí | `0` | Minuto de ejecución del job matutino (`0`–`59`) |
| `CUSTODY_MORNING_JOB_INTERVAL_MS` | No *(pendiente en `.env.example`)* | `60000` | Intervalo de sondeo del job matutino en ms (`>= 1000`) |
| `CURRENT_KEY_VERSION` | Sí | `v1` | Versión activa de llave para AES-256-GCM |
| `APP_ENCRYPTION_MASTER_KEY` | Sí | *(clave dummy Base64 de 32 bytes)* | Llave maestra AES-256-GCM en Base64 (reemplazar fuera de dev) |
| `APP_BLIND_INDEX_HMAC_KEY` | Sí | *(clave dummy Base64)* | Clave independiente para Blind Index HMAC-SHA256 |
| `JWT_SECRET` | Sí | *(valor de desarrollo)* | Secreto de firma JWT |
| `JWT_EXPIRES_IN` | Sí | `15m` | Expiración del Access Token |
| `JWT_REFRESH_EXPIRES_IN` | Sí | `7d` | Expiración del Refresh Token |
| `SMTP_HOST` | Sí | *(vacío)* | Servidor SMTP para OTP MFA por correo (vacío = log en dev; obligatorio en prod) |
| `SMTP_PORT` | Sí | `587` | Puerto SMTP |
| `SMTP_SECURE` | Sí | `false` | TLS directo en SMTP (`true`/`false`) |
| `SMTP_USER` | Sí | *(vacío)* | Usuario SMTP |
| `SMTP_PASSWORD` | Sí | *(vacío)* | Contraseña SMTP |
| `MAIL_FROM` | Sí | `Camino Seguro <no-reply@caminoseguro.edu.co>` | Remitente de correos OTP |
| `MQTT_BROKER_URL` | Sí | `mqtt://localhost:1883` | URL del broker MQTT (telemetría IoT) |

> Para la base de datos en contenedor, consulta las variables de `db/.env.example` documentadas en [docs/modules/database-migrations.md](docs/modules/database-migrations.md).

### 4. Levantar PostgreSQL 16 + PostGIS y ejecutar migraciones

1. Inicia el servicio de base de datos desde la carpeta `db/`:

   ```bash
   cd db
   docker compose up -d
   ```

   El contenedor `camino-seguro-postgres` (`postgis/postgis:16-3.4`) ejecuta automáticamente `docker/postgres/00_init_roles_dev.sql` en la primera inicialización del volumen y monta `./migrations` en `/docker-entrypoint-initdb.d/migrations`.

2. Ejecuta y valida las migraciones DDL secuenciales con el script correspondiente a tu sistema operativo:

   - **Windows (PowerShell):**
     ```powershell
     .\db\scripts\verify-migrations.ps1
     ```
   - **Linux / macOS / CI (Bash):**
     ```bash
     ./db/scripts/verify-migrations.sh
     ```

   > **Estado de verificación:** *pendiente de verificar* en vivo en este entorno (Docker Desktop no se encontraba en ejecución y no hay `psql` nativo instalado en el host). Consulta detalles completos, tablas, roles y pruebas SQL en [docs/modules/database-migrations.md](docs/modules/database-migrations.md).

---

## Compilación, Pruebas, Lint y Ejecución

### Compilación (`build`)

```bash
npm run build
```

Compila TypeScript con `nest build` en `dist/`. *(Comprobado: finaliza con código de salida `0`.)*

### Pruebas unitarias y HTTP (`test` y `test:cov`)

```bash
npm test
npm run test:cov
```

- `npm test` ejecuta Jest sobre `src/**/*.spec.ts`. *(Comprobado: 53 suites aprobadas, 4 suites de integración PostgreSQL/PostGIS omitidas cuando no hay BD configurada, 400 pruebas aprobadas y 11 omitidas; código de salida `0`.)*
- `npm run test:cov` genera el reporte en `coverage/`. *(Comprobado: cobertura global actual de 79.36% sentencias / 78.71% líneas con las 4 suites de integración PostgreSQL omitidas.)*

### Pruebas E2E (`test:e2e`)

```bash
npm run test:e2e
```

> **Aviso (estado actual comprobado):** `test/app.e2e-spec.ts` aprueba (`1/1`), pero `test/auth.e2e-spec.ts` falla actualmente (`17/17`) con `Nest could not find OtpMfaService element (this provider does not exist in the current context)`.

### Lint y formato (`lint` y `format`)

```bash
npm run lint
npm run format
```

> **Aviso (estado actual comprobado):** `npm run lint` (`eslint "{src,apps,libs,test}/**/*.ts" --fix`) falla actualmente con `ESLint couldn't find a configuration file` porque el repositorio no incluye un archivo de configuración de ESLint (`.eslintrc.*`).

### Iniciar el servidor

```bash
npm run start:dev
```

- Base URL por defecto: `http://localhost:3000/api/v1`
- Documentación OpenAPI / Swagger: `http://localhost:3000/api/v1/docs`

*(Nota: la ejecución de `start:dev` en segundo plano queda pendiente de verificar junto con una instancia activa de PostgreSQL si se habilitan los flags `*_USE_POSTGRES=true` / `GEO_USE_POSTGIS=true`.)*

### Resumen de scripts de `package.json`

| Script | Comando subyacente | Estado verificado |
| --- | --- | --- |
| `npm run build` | `nest build` | Comprobado (OK) |
| `npm test` | `jest` | Comprobado (OK: 53 suites, 400 tests; 4 suites de integración BD omitidas) |
| `npm run test:cov` | `jest --coverage` | Comprobado (OK: 79.36% stmts / 78.71% lines) |
| `npm run test:e2e` | `jest --config ./test/jest-e2e.json` | Falla actualmente en `test/auth.e2e-spec.ts` |
| `npm run lint` | `eslint "{src,apps,libs,test}/**/*.ts" --fix` | Falla actualmente (falta archivo de configuración ESLint) |
| `npm run format` | `prettier --write "src/**/*.ts" "test/**/*.ts"` | Disponible (no ejecutado para no modificar código fuente) |
| `npm run start` / `start:dev` / `start:debug` / `start:prod` | `nest start` / `node dist/main` | Disponibles |

---

## Estructura del Proyecto

```text
.
├── .env.example                          # Plantilla de variables de entorno de la API
├── .github/
│   ├── ISSUE_TEMPLATE/                   # Plantillas de issues (bug, feature, security)
│   └── skills/gitflow-workflow/SKILL.md  # Procedimiento GitFlow con PRs y ramas protegidas
├── db/
│   ├── .env.example                      # Plantilla de variables de PostgreSQL y roles
│   ├── docker-compose.yml                # Servicio PostgreSQL 16 + PostGIS 3.4
│   ├── migrations/
│   │   ├── V001__...sql .. V010__...sql  # DDL fundacional (Issue #2)
│   │   ├── V011__...sql .. V016__...sql  # Migraciones incrementales (Sprints 1 y 2)
│   │   └── undo/                         # Scripts reversibles U013 a U016
│   └── scripts/
│       ├── verify-migrations.ps1         # Verificador de migraciones (Windows PowerShell)
│       ├── verify-migrations.sh          # Verificador de migraciones (Linux/CI)
│       └── test-validation-queries.sql   # Suite de validación SQL e inmutabilidad WORM
├── docker/
│   └── postgres/00_init_roles_dev.sql    # Inicialización local de roles sin claves quemadas
├── docs/
│   ├── adr/                              # Decisiones de arquitectura (ADR-001, ADR-002)
│   ├── architecture/backend-blueprint.md # Mapa de sprints, puertos y roles
│   ├── issues/                           # Especificaciones originales de issues (#1–#23)
│   ├── modules/                          # Documentación técnica por módulo implementado
│   └── traceability.md                   # Matriz de trazabilidad Issue → Módulo → Documento
├── src/
│   ├── main.ts                           # Bootstrap (SanitizingLogger, Helmet, CORS, Swagger)
│   ├── app.module.ts                     # Orquestación de ConfigModule, CryptoModule y módulos
│   ├── config/env.validation.ts          # Esquema Joi de variables de entorno
│   ├── common/
│   │   ├── crypto/                       # AES-256-GCM, Blind Index HMAC, HashService, Vault
│   │   ├── decorators/                   # @CurrentUser, @Roles, @Public, @IdempotencyKey
│   │   ├── enums/                        # RoleEnum, CustodyStateEnum, TripStateEnum, AuditActionEnum
│   │   ├── filters/                      # AllExceptionsFilter (sanitización de PII)
│   │   ├── guards/                       # RolesGuard, MfaGuard
│   │   ├── interceptors/                 # LoggingInterceptor, TransformInterceptor
│   │   ├── pipes/                        # ParseUUIDv7Pipe
│   │   ├── ports/                        # 8 puertos hexagonales (IRepository, ICryptoVaultPort, etc.)
│   │   ├── security/                     # pii-sanitizer, SanitizingLogger
│   │   └── utils/                        # Generador uuidv7() RFC 9562
│   └── modules/
│       ├── auth/                         # Issue #3: JWT, rotación, RBAC, MFA
│       ├── mailer/                       # Transporte SMTP / log dev para OTP MFA
│       ├── students/                     # Issues #4 y #5: Expediente cifrado e importación masiva
│       ├── routes/                       # Issue #6: Rutas, paradas GiST y geocercas
│       ├── custody/                      # Issue #7: FSM de custodia y cadena WORM
│       ├── attendance/                   # Issues #8 y #9: Abordaje QR, desembarque y receptores
│       ├── schools/                      # Soporte institucional
│       ├── transport-companies/          # Soporte de empresas transportadoras
│       ├── trips/                        # Gestión base de viajes
│       ├── passengers/                   # Base Sprint 3 (fuera de alcance)
│       ├── telemetry/                    # Base Sprint 3 (fuera de alcance)
│       ├── tracking/                     # Base Sprint 3 (fuera de alcance)
│       ├── notifications/                # Base Sprint 3 (usado por eventos de custodia/asistencia)
│       ├── offline/                      # Base Sprint 4 (fuera de alcance)
│       ├── audit/                        # Bitácora forense en memoria / puerto IAuditLedgerPort
│       └── billing-isolation/            # Base Sprint 4 (fuera de alcance)
└── test/                                 # Pruebas E2E (app.e2e-spec.ts, auth.e2e-spec.ts)
```

---

## Arquitectura y Documentación

- **Trazabilidad Issue → Módulo → Documento:** [docs/traceability.md](docs/traceability.md)
- **Blueprint general:** [docs/architecture/backend-blueprint.md](docs/architecture/backend-blueprint.md)
- **ADRs:**
  - [ADR-001: Arquitectura Hexagonal (Ports & Adapters) y Clean Architecture](docs/adr/ADR-001-arquitectura-hexagonal.md)
  - [ADR-002: Inmutabilidad Criptográfica WORM y Bóveda de Datos Sensibles](docs/adr/ADR-002-inmutabilidad-criptografica-worm.md)
- **Documentación por módulo (`docs/modules/`):**
  - [Base de datos PostgreSQL 16 + PostGIS y migraciones](docs/modules/database-migrations.md)
  - [Autenticación JWT con rotación, RBAC y MFA](docs/modules/auth.md)
  - [Criptovault AES-256-GCM, Blind Indexing y Expedientes](docs/modules/crypto-vault.md)
  - [Importación masiva de matrículas](docs/modules/enrollment-import.md)
- **Gobernanza y flujo de trabajo:**
  - Política de seguridad: [SECURITY.md](SECURITY.md)
  - Guía de contribución: [CONTRIBUTING.md](CONTRIBUTING.md)
  - Procedimiento GitFlow con ramas protegidas (`develop` / `feature/*` / PR): [.github/skills/gitflow-workflow/SKILL.md](.github/skills/gitflow-workflow/SKILL.md)
