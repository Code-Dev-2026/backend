# Camino Seguro — Backend Core API & Telemetry Engine

[![NestJS](https://img.shields.io/badge/Framework-NestJS%2010+-E0234E?logo=nestjs&logoColor=white)](https://nestjs.com/)
[![TypeScript](https://img.shields.io/badge/Language-TypeScript%205.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/Database-PostgreSQL%2016%20%2B%20PostGIS-336791?logo=postgresql&logoColor=white)](https://postgis.net/)
[![Socket.IO](https://img.shields.io/badge/RealTime-Socket.IO%204.x-010101?logo=socketdotio&logoColor=white)](https://socket.io/)
[![MQTT](https://img.shields.io/badge/IoT-MQTT%20Telemetry-660066?logo=eclipsemosquitto&logoColor=white)](https://mqtt.org/)
[![Architecture](https://img.shields.io/badge/Architecture-Clean%20%2F%20Hexagonal%20(Ports%20%26%20Adapters)-blue)](#arquitectura-y-principios-solid)
[![SOLID](https://img.shields.io/badge/Design-100%25%20SOLID%20Compliant-success)](#arquitectura-y-principios-solid)

Plataforma backend de alto rendimiento encargada de centralizar la lógica de negocio, gobernanza de seguridad, ingesta telemática vehicular IoT y procesamiento geoespacial para el sistema **"Camino Seguro"** del **Colegio San Benito del Otún**, operado en convenio con **Transportes Camino Seguro S.A.S.** en Pereira, Risaralda.

---

## 1. Propósito

El propósito de este servicio backend es actuar como la **Única Fuente de Verdad (Single Source of Truth - SSOT)** institucional para la cadena de custodia de menores y la operación del transporte escolar, erradicando los riesgos derivados de la asimetría de información, el registro en planillas manuales, la improvisación en canales no oficiales (grupos de WhatsApp) y los bloqueos injustificados en vía pública.

Mediante una arquitectura desacoplada, orientada a eventos e inmutable, el backend garantiza:
1. **Seguridad y Certeza en Custodia:** Modelado estricto del ciclo de vida diario del estudiante como una máquina de estados finitos inalterable con verificación visual biométrica del receptor legal y alertas rojas judiciales bloqueantes.
2. **Control Operativo Inteligente:** Eliminación absoluta del sobrecupo en vehículos mediante validaciones transaccionales en tiempo real, gestión de pasajeros ocasionales y trazado de rutas con paradas oficiales inmutables.
3. **Monitoreo Satelital No Intrusivo:** Procesamiento de telemetría proveniente exclusivamente de hardware GPS fijo vehicular vía MQTT/PostGIS, detectando desvíos de ruta (>300m) y calculando tiempos estimados de arribo (ETA).
4. **Protección Legal y Ética:** Cumplimiento riguroso de la Ley Estatutaria 1581 de 2012 (Habeas Data de Menores) y desacoplamiento absoluto de la cobranza financiera frente al abordaje físico.

---

## 2. Alcance

El backend cubre el **100% de los requerimientos y reglas de negocio del SRS v2.0**, distribuidos en 5 módulos funcionales y una capa transversal de arquitectura no funcional:

### 2.1 Módulos Funcionales (RF-01 al RF-20)
- **Módulo 1: Gestión Unificada de Estudiantes y Rutas (RF-01, RF-02, RF-03, RF-04, RF-17, RF-18):**
  - Ingesta digital y cruce masivo de matrículas escolares contra cupos vehiculares; prevención de duplicados (`RF-01`).
  - Control de asistencia por escaneo y decodificación de token QR institucional en < 2 segundos (`RF-02`).
  - Validación transaccional de capacidad nominal vehicular; denegación dura del abordaje N+1 (`RF-03`).
  - Asignación condicionada de pasajeros ocasionales sujeta a inasistencia previa reportada con >= 2 horas de anticipación (`RF-04`).
  - Planificación y trazado vectorial de rutas con paradas georreferenciadas (`ST_Point`) y polilíneas oficiales (`RF-17`).
  - Detección automática en streaming de desvíos superiores a 300 metros sobre la polilínea oficial (`RF-18`).

- **Módulo 2: Custodia, Entregas y Protocolos de Seguridad (RF-05, RF-06, RF-07, RF-08):**
  - Almacenamiento cifrado (AES-256) de fichas de custodia (hasta 3 adultos legitimados por menor con fotos y documentos) (`RF-05`).
  - Verificación digital en parada antes del cambio de estado a "Entregado", ligando el evento al ID del adulto presente (`RF-06`).
  - Despliegue de alertas rojas bloqueantes ante sentencias u órdenes judiciales de restricción de custodia (`RF-07`).
  - Activación automatizada del protocolo de contingencia por desembarque fallido tras 3 minutos de cortesía y retorno seguro al colegio (`RF-08`).

- **Módulo 3: Monitoreo GPS, Telemetría y Mapa en Tiempo Real (RF-09, RF-10, RF-11, RF-19):**
  - Ingesta telemática satelital vía MQTT cada 5 segundos desde hardware M2M fijo sin invadir dispositivos de transportistas (`RF-09`).
  - Endpoint de sincronización asíncrona idempotente con colas FIFO para paquetes capturados en zonas sin cobertura (`RF-10`).
  - Algoritmo geoespacial para cálculo de cercas virtuales y estimación de llegada (ETA 5 a 10 min) (`RF-11`).
  - Gateway WebSocket con **privacidad diferencial por rol**: visibilidad exclusiva del bus donde viaja el hijo y apagado automático post-entrega (`RF-19`).

- **Módulo 4: Comunicación Institucional, Notificaciones Push y Alertas (RF-12, RF-13, RF-14, RF-20):**
  - Despacho institucional segmentado y masivo con auditoría de entrega, erradicando chats informales (`RF-12`).
  - Matriz de roles e intervención superior con MFA para la Coordinadora de Convivencia (`RF-13`).
  - Alerta preventiva automatizada 500m antes de entrar a zonas de sombra celular homologadas (ej. La Virginia) (`RF-14`).
  - Motor de notificaciones transaccionales automáticas con latencia < 2.5s ante transiciones de estado (`RF-20`).

- **Módulo 5: Gestión Administrativa y Cartera (RF-15, RF-16):**
  - Desacoplamiento total de cartera: el backend prohíbe taxativamente bloqueos o discriminación en el abordaje por mora financiera (`RF-15`).
  - Generación de bitácoras de auditoría forense inmutables exportables a PDF con firma digital y Excel (`RF-16`).

### 2.2 Requisitos No Funcionales (RNF) y Reglas de Negocio (RN)
- **Seguridad (RNF-01, RNF-08, RNF-09):** TLS 1.3, AES-256 en reposo, firmas HMAC-SHA256 para eventos de custodia, soft-delete estricto con hash forense e inmutabilidad en base de datos.
- **Rendimiento & SLA (RNF-03, RNF-05):** Disponibilidad del 99.9% en franja 05:00 a 19:30, latencia push < 2.5 segundos.
- **Resiliencia (RNF-06):** Soporte de sincronización offline con buffer transaccional > 12 horas sin colisiones.
- **Reglas Duras (RN-01 a RN-07):** Identificación exclusiva por QR institucional; Cero sobrecupo absoluto; Invitaciones ocasionales solo por inasistencia previa; Protección legal de custodia intransigente; Inmunidad operativa por mora; Paradas oficiales inmutables en marcha; Privacidad temporal de mapa en vivo.

### 2.3 Exclusiones Explícitas (Fuera de Alcance)
- Hardware biométrico dactilar/facial físico empotrado en el bus.
- Inmovilización o corte de ignición remota del vehículo por causales financieras.
- Salas de chat libre bidireccional entre acudientes y conductores.

---

## 3. Objetivos

### 3.1 Objetivo General
Diseñar, implementar y desplegar una plataforma backend basada en NestJS, TypeScript, PostgreSQL/PostGIS y WebSockets con arquitectura Hexagonal y cumplimiento estricto de los principios SOLID, garantizando un SLA del 99.9%, latencia inferior a 2.5s y la protección inquebrantable de la cadena de custodia de menores.

### 3.2 Objetivos Específicos
1. **Implementar el Motor de Estados Finitos:** Modelar el ciclo de vida del menor con transiciones deterministas, inmutables y trazables, integrando el disparo de eventos de dominio hacia los subsistemas de notificación y auditoría.
2. **Construir el Pipeline Telemático IoT & PostGIS:** Desarrollar el consumidor MQTT y los casos de uso espaciales para proyectar coordenadas sobre polilíneas viales, calcular alertas de desvío (>300m) y disparar geocercas predictivas (ETA 5-10 min).
3. **Asegurar Privacidad Diferencial y Multi-Tenancy:** Desarrollar gateways de WebSocket y guards de autorización por capas (RBAC + MFA) que restrinjan la telemetría vehicular exclusivamente al tutor legitimado mientras el menor esté a bordo.
4. **Garantizar Resiliencia Offline Idempotente:** Crear servicios de ingesta en bloque para la reconciliación transaccional de colas FIFO provenientes del almacenamiento SQLite móvil tras el cruce de puntos ciegos celulares.
5. **Establecer Trazabilidad Forense Inmutable:** Implementar un registro de auditoría con encadenamiento criptográfico que impida la alteración histórica de eventos de abordaje, alertas rojas y actas de desembarque.

---

## 4. Arquitectura y Principios SOLID

El backend se estructura siguiendo **Clean Architecture (Puertos y Adaptadores / Arquitectura Hexagonal)**, desacoplando el Dominio y los Casos de Uso de la Infraestructura tecnológica (Postgres, Redis, MQTT, Firebase):

```
┌────────────────────────────────────────────────────────────────────────┐
│                        ADAPTADORES DE ENTRADA                          │
│     Controllers (REST)    │   Gateways (WebSockets)   │   MQTT Consumer│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ (DTOs)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                          PUERTOS DE ENTRADA                            │
│                 Interfaces de Casos de Uso (Application)                │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                            NÚCLEO DE DOMINIO                           │
│        Entities Ricas     │    Value Objects    │    Domain Events     │
│        (Student, Route)   │    (Coordinates)    │    (StateChanged)    │
│                     Máquina de Estados Finitos                         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                          PUERTOS DE SALIDA                             │
│   IStudentRepository │ ITelemetryPublisher │ INotificationChannel      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ (Inversión de Dependencias)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        ADAPTADORES DE SALIDA                           │
│   TypeORM / PostGIS  │  Redis BullMQ Queue  │  Firebase FCM & Twilio   │
└────────────────────────────────────────────────────────────────────────┘
```

### Aplicación Estricta de Principios SOLID

| Principio | Aplicación en el Backend de Camino Seguro |
| :--- | :--- |
| **S — Single Responsibility (SRP)** | Cada clase tiene una única razón de cambio. Los controladores solo parsean HTTP/WS; los casos de uso (`RegisterQrBoardingUseCase`, `DetectRouteDeviationUseCase`) ejecutan una sola regla de negocio; los servicios de dominio gobiernan invariantes; y los adaptadores de infraestructura gestionan conexiones externas. |
| **O — Open/Closed (OCP)** | El sistema está abierto a la extensión pero cerrado a la modificación. El motor de notificaciones (`NotificationDispatcher`) implementa el patrón Strategy sobre la interfaz `INotificationChannel`; agregar un nuevo canal (SMS, WhatsApp, Email) no altera la lógica de los casos de uso. |
| **L — Liskov Substitution (LSP)** | Cualquier implementación de los puertos de persistencia o telemetría puede sustituir a su abstracción sin alterar la estabilidad del sistema. Por ejemplo, `PostgreSqlStudentRepository` y un `InMemoryStudentRepository` (para tests) satisfacen idénticamente `IStudentRepository`. |
| **I — Interface Segregation (ISP)** | Se diseñan interfaces pequeñas y de grano fino. En lugar de un repositorio monolítico, se segregan contratos: `IStudentReader`, `IStudentAttendanceWriter`, `IRouteGeometryQuery`, `IAuditableEventLogger`. Los clientes solo conocen los métodos que requieren. |
| **D — Dependency Inversion (DIP)** | El Dominio y la Aplicación dependen exclusivamente de abstracciones (Puertos/Interfaces). La infraestructura (TypeORM, PostGIS, MQTT, Firebase) depende de dichas abstracciones. En NestJS, la inyección de dependencias desacopla las implementaciones concretas mediante Injection Tokens (`@Inject('STUDENT_REPOSITORY')`). |

---

## 5. Stack Tecnológico

- **Core & Runtime:** [Node.js 20+ LTS](https://nodejs.org/) & [TypeScript 5+](https://www.typescriptlang.org/)
- **Framework Web:** [NestJS 10+](https://nestjs.com/) (Arquitectura Modular, Inyección de Dependencias, Pipes, Guards, Interceptors)
- **Base de Datos Principal:** [PostgreSQL 16](https://www.postgresql.org/) con extensión geoespacial [PostGIS 3.4](https://postgis.net/)
- **ORM & Migraciones:** [TypeORM](https://typeorm.io/) / [Prisma](https://www.prisma.io/) con tipos de datos espaciales (`geometry(Point, 4326)`, `geometry(LineString, 4326)`)
- **Procesamiento Asíncrono & Cache:** [Redis 7+](https://redis.io/) con [BullMQ](https://docs.bullmq.io/) para colas transaccionales y broker Pub/Sub
- **Broker IoT Satelital:** [Eclipse Mosquitto](https://mosquitto.org/) / [EMQX](https://www.emqx.io/) sobre protocolo MQTT v5
- **Comunicación en Tiempo Real:** [Socket.IO 4+](https://socket.io/) con Redis Adapter para clustering y rooms diferenciales
- **Seguridad & Identidad:** Passport-JWT, Argon2, [Speakeasy](https://github.com/speakeasyjs/speakeasy) (MFA TOTP), Crypto (AES-256-GCM y SHA-256)
- **Notificaciones Push & SMS:** [Firebase Admin SDK](https://firebase.google.com/) (FCM) y Twilio API (SMS transaccional de contingencia)
- **Contenedores & Testing:** Docker, Docker Compose, [Jest](https://jestjs.io/) y Supertest

---

## 6. Estructura del Proyecto (Clean Architecture)

```
backend/
├── src/
│   ├── common/                          # Componentes compartidos y utilitarios
│   │   ├── decorators/                  # @Roles, @CurrentUser, @Public
│   │   ├── filters/                     # Manejo centralizado de excepciones
│   │   ├── guards/                      # JwtAuthGuard, RolesGuard, MfaGuard
│   │   └── interceptors/                # AuditLoggingInterceptor, TransformInterceptor
│   ├── config/                          # Configuración y validación de variables de entorno
│   ├── core/                            # Núcleo de Dominio y Casos de Uso (Hexagonal)
│   │   ├── domain/                      # Entidades ricas, Value Objects y Domain Events
│   │   │   ├── student/                 # Entidad Student, Máquina de Estados, Eventos
│   │   │   ├── route/                   # Entidad Route, Paraderos, Polilíneas PostGIS
│   │   │   ├── vehicle/                 # Entidad Vehicle, Capacidad Nominal, Módem GPS
│   │   │   └── custody/                 # Expedientes, Alertas Judiciales Rojas
│   │   ├── use-cases/                   # Casos de uso de aplicación (SRP)
│   │   │   ├── attendance/              # RegisterQrBoarding, VerifyDisembark
│   │   │   ├── telemetry/               # IngestTelemetry, DetectRouteDeviation
│   │   │   ├── geofence/                # CalculateGeofenceEta
│   │   │   ├── offline-sync/            # ProcessOfflineBatchSync
│   │   │   └── notifications/           # DispatchStateNotification
│   │   └── ports/                       # Interfaces abstractas (DIP / ISP)
│   │       ├── in/                      # Puertos de entrada (Casos de uso)
│   │       └── out/                     # Puertos de salida (Repositorios, Notificadores)
│   ├── infrastructure/                  # Adaptadores externos y tecnologías
│   │   ├── adapters/
│   │   │   ├── persistence/             # Implementaciones TypeORM + PostGIS
│   │   │   ├── telemetry/               # Consumidor MQTT y listeners de módems
│   │   │   ├── notifications/           # Adaptadores Firebase FCM y SMS Twilio
│   │   │   └── websockets/              # Socket.IO Gateway con privacidad diferencial
│   │   └── controllers/                 # Controladores REST API
│   ├── app.module.ts
│   └── main.ts
├── docker-compose.yml                   # Postgres (PostGIS), Redis, Mosquitto
├── Dockerfile
├── .env.example
└── README.md
```

---

## 7. Variables de Entorno (`.env.example`)

```env
# Servidor
PORT=3000
NODE_ENV=development
API_PREFIX=/api/v1

# Seguridad
JWT_SECRET=super_secret_jwt_key_development_32chars
JWT_EXPIRATION=15m
JWT_REFRESH_SECRET=super_secret_refresh_key_development_32chars
JWT_REFRESH_EXPIRATION=7d
MFA_SERVICE_NAME=CaminoSeguroBackend
AES_256_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

# Base de Datos PostgreSQL + PostGIS
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=postgres
DB_DATABASE=camino_seguro_db
DB_SYNCHRONIZE=false

# Redis & Colas (BullMQ)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Broker MQTT
MQTT_BROKER_URL=mqtt://localhost:1883
MQTT_CLIENT_ID=backend_telemetry_worker
MQTT_TOPIC_TELEMETRY=vehicles/+/telemetry

# Firebase Admin SDK (FCM)
FIREBASE_PROJECT_ID=camino-seguro-firebase
FIREBASE_CLIENT_EMAIL=firebase-adminsdk@camino-seguro.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

---

## 8. Instalación y Ejecución Local

```bash
# 1. Clonar el repositorio
git clone https://github.com/Code-Dev-2026/backend.git
cd backend

# 2. Instalar dependencias
npm install

# 3. Levantar infraestructura Docker (Postgres/PostGIS, Redis, Mosquitto)
docker-compose up -d

# 4. Configurar variables de entorno
cp .env.example .env

# 5. Ejecutar migraciones de base de datos
npm run migration:run

# 6. Iniciar en modo desarrollo
npm run start:dev
```

Documentación interactiva OpenAPI: `http://localhost:3000/api/docs`

---

## 9. Integrantes del Proyecto

- **Jhonatan Mauricio Muchavisoy Jajoy**
- **Aura Camila Arteaga Castillo**
