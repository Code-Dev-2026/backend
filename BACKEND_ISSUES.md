# Camino Seguro — Especificación Técnica de GitHub Issues del Backend

Este documento compila el backlog oficial de **Issues de Ingeniería de Backend** para el proyecto **"Camino Seguro"** (Colegio San Benito del Otún / Transportes Camino Seguro S.A.S. - Pereira, Risaralda).

Cada issue cumple rigurosamente con los **5 Principios SOLID (S, O, L, I, D)**, la arquitectura de **Puertos y Adaptadores (Hexagonal)** en **NestJS**, los 20 Requerimientos Funcionales (**RF-01 al RF-20**), los 9 Requerimientos No Funcionales (**RNF-01 al RNF-09**) y las 7 Reglas de Negocio (**RN-01 al RN-07**) de la Especificación de Requerimientos de Software (SRS v2.0).

---

## Índice de Issues por Épica

1. [ÉPICA 1: Arquitectura Base, Infraestructura & Seguridad](#épica-1-arquitectura-base-infraestructura--seguridad)
   - [ISSUE #01: Setup de Arquitectura Hexagonal en NestJS y Docker Compose](#issue-01-arch-setup-de-arquitectura-hexagonal-en-nestjs-inversión-de-dependencias-dip-y-docker-compose-multi-servicio)
   - [ISSUE #02: Módulo de Identidad, JWT con Rotación, RBAC en Capas y MFA TOTP](#issue-02-auth-módulo-de-identidad-jwt-con-rotación-rbac-en-capas-y-mfa-totp-para-coordinación)
2. [ÉPICA 2: Gestión de Rutas Geoespaciales, Matrículas & Cartera](#épica-2-gestión-de-rutas-geoespaciales-matrículas--cartera)
   - [ISSUE #03: Modelado Geoespacial de Rutas, Paraderos y Polilíneas con PostGIS](#issue-03-geo-modelado-geoespacial-de-rutas-paraderos-oficiales-y-polilíneas-con-postgis)
   - [ISSUE #04: Ingesta Masiva de Matrícula, Normalización y Cruce de Cupos](#issue-04-students-ingesta-masiva-de-matrícula-normalización-y-cruce-contra-cupos-homologados)
   - [ISSUE #05: Desacoplamiento Absoluto de Cartera e Inmunidad Operativa por Mora](#issue-05-billing-desacoplamiento-arquitectónico-absoluto-de-cartera-y-garantía-de-inmunidad-operativa-por-mora)
3. [ÉPICA 3: Máquina de Estados, Abordaje QR, Cupos y Custodia](#épica-3-máquina-de-estados-abordaje-qr-cupos-y-custodia)
   - [ISSUE #06: Motor de Máquina de Estados Finitos Inmutable para Custodia](#issue-06-core-fsm-motor-de-máquina-de-estados-finitos-inmutable-para-la-cadena-de-custodia-del-menor)
   - [ISSUE #07: Validación de Asistencia QR y Control Atómico de Capacidad Nominal](#issue-07-attendance-validación-de-asistencia-qr-y-control-atómico-de-capacidad-nominal-anti-sobrecupo)
   - [ISSUE #08: Gestión Transaccional de Pasajeros Ocasionales por Inasistencia Previa](#issue-08-passengers-gestión-transaccional-de-pasajeros-ocasionales-condicionada-a-inasistencia-previa)
   - [ISSUE #09: Expediente Cifrado (AES-256) de Autorizados y Alertas Rojas Judiciales](#issue-09-custody-vault-expediente-cifrado-aes-256-de-autorizados-y-motor-de-alertas-rojas-judiciales)
   - [ISSUE #10: Verificación Visual de Desembarque y Protocolo de Retorno Seguro](#issue-10-disembark-verificación-visual-de-desembarque-y-protocolo-automatizado-de-retorno-seguro)
4. [ÉPICA 4: Telemetría GPS, Geocercas, Desvíos y Sincronización Offline](#épica-4-telemetría-gps-geocercas-desvíos-y-sincronización-offline)
   - [ISSUE #11: Pipeline de Telemetría IoT desde Módems GPS Fijos vía MQTT y HTTPS](#issue-11-telemetry-ingest-pipeline-de-telemetría-iot-desde-módems-gps-fijos-vía-broker-mqtt-y-https)
   - [ISSUE #12: Algoritmo Geoespacial PostGIS en Streaming para Desvíos (>300m)](#issue-12-geo-deviation-algoritmo-geoespacial-postgis-en-streaming-para-detección-de-desvíos-300m)
   - [ISSUE #13: Motor de Cercas Virtuales y Estimación Predictiva de Arribo (ETA 5-10 min)](#issue-13-geofence-eta-motor-de-cercas-virtuales-y-estimación-predictiva-de-arribo-eta-5-10-min)
   - [ISSUE #14: Sincronización Idempotente FIFO para Puntos Ciegos (La Virginia)](#issue-14-offline-sync-endpoint-de-sincronización-idempotente-fifo-para-puntos-ciegos-y-detección-de-zonas-de-sombra)
5. [ÉPICA 5: Streaming en Tiempo Real & Notificaciones](#épica-5-streaming-en-tiempo-real--notificaciones)
   - [ISSUE #15: Servidor Socket.IO con Privacidad Diferencial y Salas Segmentadas](#issue-15-realtime-ws-servidor-socketio-con-privacidad-diferencial-y-salas-segmentadas-por-viaje)
   - [ISSUE #16: Despachador Transaccional de Notificaciones Push (FCM) y Fallback SMS](#issue-16-notifications-despachador-transaccional-de-notificaciones-push-fcm-con-fallback-sms)
6. [ÉPICA 6: Auditoría Forense & Reportes Oficiales](#épica-6-auditoría-forense--reportes-oficiales)
   - [ISSUE #17: Bitácora Criptográfica Inmutable (SHA-256) y Reportes PDF/Excel](#issue-17-forensic-audit-bitácora-criptográfica-inmutable-sha-256-y-exportador-de-reportes-probatorios-pdfexcel)

---

## ÉPICA 1: Arquitectura Base, Infraestructura & Seguridad

### `[ISSUE #01] [ARCH] Setup de Arquitectura Hexagonal en NestJS, Inversión de Dependencias (DIP) y Docker Compose Multi-Servicio`
- **Etiquetas:** `architecture`, `devops`, `solid:dip`, `priority:critical`
- **Trazabilidad SRS:** RNF-01, RNF-03 (SLA 99.9%), Stack Tecnológico Propuesto.
- **Desglose de Principios SOLID:**
  - **S (Single Responsibility):** La configuración del bootstrap (`main.ts`) solo orquesta el arranque; cada módulo (`CoreModule`, `InfrastructureModule`, `CommonModule`) gestiona su propio contexto sin acoplarse.
  - **O (Open/Closed):** La arquitectura permite incorporar nuevos adaptadores de transporte (gRPC, GraphQL) o proveedores de base de datos sin modificar el dominio.
  - **L (Liskov Substitution):** La infraestructura expone implementaciones sustituibles para entornos de test (e.g. `InMemoryDatabaseAdapter`) vs producción (`PostgreSqlAdapter`).
  - **I (Interface Segregation):** Se configuran interfaces de configuración atómicas (`IDatabaseConfig`, `IRedisConfig`, `IMqttConfig`, `IJwtConfig`) en lugar de una interfaz de configuración monolítica.
  - **D (Dependency Inversion):** Los módulos de aplicación consumen abstracciones inyectadas por tokens (`@Inject('DATABASE_CONNECTION')`), nunca implementaciones directas de TypeORM o pg-driver.
- **Especificación Técnica y Contratos:**
  ```typescript
  // src/core/ports/out/database.interface.ts
  export interface IDatabaseConfig {
    readonly host: string;
    readonly port: number;
    readonly database: string;
  }
  ```
- **Criterios de Aceptación (DoD):**
  - [ ] Docker Compose inicializa: PostgreSQL 16 con extensión PostGIS 3.4 (`postgis`), Redis 7 y Eclipse Mosquitto MQTT v5.
  - [ ] Configuración global de `ValidationPipe` con sanitización estricta (`whitelist: true`, `forbidNonWhitelisted: true`).
  - [ ] Filtro global de excepciones `HttpExceptionFilter` formateado bajo el estándar RFC 7807 (Problem Details).
  - [ ] Documentación OpenAPI / Swagger activa en `/api/docs`.

---

### `[ISSUE #02] [AUTH] Módulo de Identidad, JWT con Rotación, RBAC en Capas y MFA TOTP para Coordinación`
- **Etiquetas:** `security`, `auth`, `solid:srp`, `solid:isp`, `priority:critical`
- **Trazabilidad SRS:** RF-13 (Matriz de Roles e Intervención Superior), RNF-01 (Seguridad Ley 1581), RNF-02 (Privacidad Diferencial por Rol).
- **Desglose de Principios SOLID:**
  - **S (Single Responsibility):** `TokenService` solo firma y valida tokens; `MfaService` solo calcula y valida secretos TOTP; `AuthorizationGuard` solo verifica permisos.
  - **O (Open/Closed):** Sistema de autenticación extensible mediante estrategias de Passport (`JwtStrategy`, `MfaStrategy`) sin modificar el controlador de login.
  - **L (Liskov Substitution):** Cualquier mecanismo de validación de identidad que implemente `IIdentityVerifier` puede sustituir a la validación por base de datos (e.g. mock para pruebas E2E).
  - **I (Interface Segregation):** Segregación en interfaces estrechas: `ITokenSigner`, `ITokenValidator`, `IMfaAuthenticator`.
  - **D (Dependency Inversion):** El caso de uso `LoginUseCase` depende de la interfaz `IUserRepository` y `ITokenService`, no de TypeORM ni de `jsonwebtoken`.
- **Restricciones y Criterios de Denegación:**
  - *DENEGACIÓN DE ESCALAMIENTO NO AUTORIZADO (HU-13):* Prohibido asignar permisos de superadministrador o acceso a la matriz de intervención a conductores, monitoras o acudientes.
  - Denegación automática de acceso a endpoints de coordinación si el token JWT no incluye el claim de validación MFA verificado (`mfa_verified: true`).
- **Criterios de Aceptación (DoD):**
  - [ ] Endpoints: `/auth/login`, `/auth/refresh`, `/auth/mfa/generate`, `/auth/mfa/verify`.
  - [ ] Guards: `@UseGuards(JwtAuthGuard, RolesGuard, MfaGuard)`.
  - [ ] Tokens de acceso con caducidad de 15 minutos; tokens de refresco persistidos y revocables en Redis.

---

## ÉPICA 2: Gestión de Rutas Geoespaciales, Matrículas & Cartera

### `[ISSUE #03] [GEO] Modelado Geoespacial de Rutas, Paraderos Oficiales y Polilíneas con PostGIS`
- **Etiquetas:** `postgis`, `routes`, `gis`, `solid:ocp`, `priority:high`
- **Trazabilidad SRS:** RF-17 (Planificación y Trazado Dinámico de Rutas), HU-17, RN-06.
- **Desglose de Principios SOLID:**
  - **S (Single Responsibility):** `RouteModelerService` gestiona el grafo secuencial de paraderos; `PostGisSpatialService` resuelve exclusivamente cálculos de proyección espacial y distancias.
  - **O (Open/Closed):** La polilínea oficial puede generarse mediante OpenStreetMap, Google Roads o shapefiles locales extendiendo `IRouteRoutingProvider`.
  - **L (Liskov Substitution):** Cualquier proveedor de ruteo vehicular que devuelva una geometría `LineString` es intercambiable sin tocar la lógica de vinculación de estudiantes.
  - **I (Interface Segregation):** Interfaces segregadas: `IRouteQueryPort` (lectura de paradas) y `IRouteCommandPort` (modificación de trazados).
  - **D (Dependency Inversion):** Los casos de uso dependen del puerto `ISpatialRouteRepository`, aislando las funciones nativas `ST_GeomFromText`, `ST_Distance` y `ST_DWithin`.
- **Restricciones y Criterios de Denegación:**
  - *DENEGACIÓN DE ALTERACIÓN EN MARCHA (HU-17, RN-06):* El backend rechaza peticiones de adición, eliminación o reubicación de paradas provenientes de monitoras/conductores si la ruta está en estado `EN_TRANSITO`.
  - *RESTRICCIÓN DE PARADAS NO GEORREFERENCIADAS (HU-17):* Denegación de guardado si un paradero carece de coordenadas `(lat, lon)` válidas o se encuentra fuera del polígono municipal homologado de Pereira.
- **Criterios de Aceptación (DoD):**
  - [ ] Entidad `Route` y `RouteStop` mapeadas con columnas `geometry(Point, 4326)` y `geometry(LineString, 4326)`.
  - [ ] Algoritmo que asocia automáticamente a cada estudiante al paradero más cercano en un radio máximo parametrizado.

---

### `[ISSUE #04] [STUDENTS] Ingesta Masiva de Matrícula, Normalización y Cruce Contra Cupos Homologados`
- **Etiquetas:** `data-ingestion`, `students`, `solid:srp`, `solid:dip`, `priority:high`
- **Trazabilidad SRS:** RF-01 (Centralización de Matrícula y Cupos), HU-01, RN-02.
- **Desglose de Principios SOLID:**
  - **S (Single Responsibility):** `StudentFileParser` parsea y normaliza el archivo CSV/Excel; `StudentEnrollmentValidator` aplica las reglas de duplicidad; `StudentBatchImporterUseCase` coordina la transacción de guardado.
  - **O (Open/Closed):** Abierto a nuevos formatos de ingesta (JSON, XML, integración API directa de Rectoría) mediante la interfaz `IStudentDataParser`.
  - **L (Liskov Substitution):** `CsvStudentParser` y `ExcelStudentParser` son completamente intercambiables respetando el contrato `IStudentDataParser`.
  - **I (Interface Segregation):** Interfaces separadas: `IStudentBatchReader`, `IStudentBatchValidator`, `IStudentRepositoryWriter`.
  - **D (Dependency Inversion):** `ImportStudentsUseCase` inyecta `IStudentBatchRepository` desacoplándose del motor de persistencia relacional.
- **Restricciones y Criterios de Denegación:**
  - *DENEGACIÓN POR DUPLICIDAD (HU-01):* Rechazo atómico de la carga si existen estudiantes con documento repetido o con asignación concurrente en la misma franja horaria.
  - *RESTRICCIÓN DE MODIFICACIÓN (HU-01):* Prohibido a la empresa transportadora alterar o eliminar estudiantes sin aval formal firmado por rectoría escolar.
- **Criterios de Aceptación (DoD):**
  - [ ] Endpoint `POST /api/v1/students/batch-import` soportando multipart/form-data.
  - [ ] Transacción ACID completa: ante un solo registro inválido, rollback total y reporte estructurado de inconsistencias.
  - [ ] Tiempo de ejecución < 10 segundos para 1.000 registros de matrícula.

---

### `[ISSUE #05] [BILLING] Desacoplamiento Arquitectónico Absoluto de Cartera y Garantía de Inmunidad Operativa por Mora`
- **Etiquetas:** `billing`, `compliance`, `solid:srp`, `solid:isp`, `priority:critical`
- **Trazabilidad SRS:** RF-15 (Separación de Cobranza Operativa), HU-15, RN-05.
- **Desglose de Principios SOLID:**
  - **S (Single Responsibility):** El módulo contable `BillingModule` solo procesa estados financieros y cartas de cobro; los módulos operativos de ruta (`AttendanceModule`, `BoardingModule`) desconocen por diseño la existencia de saldos.
  - **O (Open/Closed):** Nuevas reglas de cobro (intereses, descuentos) se extienden en el módulo financiero sin impactar el motor de validación de abordaje.
  - **L (Liskov Substitution):** La interfaz de verificación de habilitación de viaje `ITripEligibilityValidator` siempre retorna `true` ante consultas de morosidad.
  - **I (Interface Segregation):** La monitora y el conductor solo consumen la interfaz `IStudentBoardingProfile`, la cual no contiene atributos financieros (`balance`, `inArrears`, `dueDate`).
  - **D (Dependency Inversion):** Los servicios de campo no inyectan ningún repositorio ni puerto relacionado con el módulo de cartera.
- **Restricciones y Criterios de Denegación:**
  - *DENEGACIÓN DE BLOQUEO POR MORA (HU-15, RN-05):* Prohibido implementar cualquier regla de software que impida el escaneo, abordaje o desembarque de un menor a causa de saldos pendientes de sus tutores.
  - *RESTRICCIÓN DE VISIBILIDAD DE CARTERA (HU-15):* Denegación con HTTP 403 ante cualquier intento de consulta de cartera por parte de los roles `MONITORA` o `CONDUCTOR`.
- **Criterios de Aceptación (DoD):**
  - [ ] Pruebas unitarias que confirmen que la validación de abordaje de un estudiante moroso no genera ningún código de error ni bandera diferenciadora.
  - [ ] Guards de autorización que aíslan completamente los endpoints de `/billing/*` fuera del alcance de la aplicación móvil de ruta.

---

## ÉPICA 3: Máquina de Estados, Abordaje QR, Cupos y Custodia

### `[ISSUE #06] [CORE-FSM] Motor de Máquina de Estados Finitos Inmutable para la Cadena de Custodia del Menor`
- **Etiquetas:** `core`, `domain`, `state-machine`, `solid:srp`, `solid:ocp`, `priority:critical`
- **Trazabilidad SRS:** Sección 4 (Diagrama de Transición de Estados), RF-02, RF-06, RF-08, RF-20.
- **Desglose de Principios SOLID:**
  - **S (Single Responsibility):** `StudentStateMachine` evalúa y valida exclusivamente las reglas de transición; la persistencia y la notificación son delegadas a escuchadores de eventos.
  - **O (Open/Closed):** Nuevas acciones secundarias ante transiciones de estado se añaden implementando el patrón Observer / Domain Events (`IStateTransitionListener`) sin modificar la máquina de estados.
  - **L (Liskov Substitution):** Los estados implementan una interfaz común `IStudentState` que gobierna qué transiciones son legales desde cada nodo.
  - **I (Interface Segregation):** Segregación entre `IStateMachineViewer` (para consultar el estado actual) e `IStateMachineExecutor` (para solicitar transiciones).
  - **D (Dependency Inversion):** La máquina de estados no conoce de base de datos ni de sockets; recibe eventos y despacha eventos de dominio puros (`StudentBoardedDomainEvent`, `StudentDisembarkedDomainEvent`).
- **Estados y Transiciones del Sistema:**
  ```
  [En Casa / Espera] ──────► (Escaneo QR exitoso) ─────► [A Bordo del Vehículo]
  [En Casa / Espera] ──────► (Reporte inasistencia) ───► [Ausente Confirmado]
  [A Bordo del Vehículo] ──► (Cotejo visual exitoso) ──► [Entregado a Adulto Autorizado]
  [A Bordo del Vehículo] ──► (Adulto ausente > 3 min) ─► [Retorno Seguro a Sede Escolar]
  [Retorno Seguro Sede] ───► (Entrega a Coordinación) ─► [En Custodia Institucional]
  ```
- **Criterios de Aceptación (DoD):**
  - [ ] Transición atómica en base de datos; bloqueo contra concurrencia optimista (`version` o `lock`).
  - [ ] Lanzamiento de `IllegalStateTransitionException` ante intentos ilegales (e.g. pasar de `En Casa` directamente a `Entregado`).

---

### `[ISSUE #07] [ATTENDANCE] Validación de Asistencia QR y Control Atómico de Capacidad Nominal (Anti-Sobrecupo)`
- **Etiquetas:** `attendance`, `qr`, `concurrency`, `solid:srp`, `priority:critical`
- **Trazabilidad SRS:** RF-02, RF-03, HU-02, HU-03, RN-01, RN-02.
- **Desglose de Principios SOLID:**
  - **S (Single Responsibility):** `QrTokenDecoder` decodifica y verifica la firma del token; `VehicleCapacityCounter` calcula el aforo actual; `BoardingService` ejecuta la transacción.
  - **O (Open/Closed):** Abierto a diferentes algoritmos de firma criptográfica de QR (HMAC-SHA256, RSA) mediante `IQrCryptographicValidator`.
  - **L (Liskov Substitution):** Cualquier validador de aforo (`RedisAtomicCounter` vs `PostgresLockCounter`) cumple idénticamente el contrato `ICapacityValidator`.
  - **I (Interface Segregation):** Contrato segregado `IQrAttendanceService` con métodos atómicos `validateBoardingQr()` y `confirmBoarding()`.
  - **D (Dependency Inversion):** Los servicios de aforo dependen de la interfaz `IVehicleOccupancyRepository`, no de comandos específicos de Redis o SQL.
- **Restricciones y Criterios de Denegación:**
  - *BLOQUEO Y DENEGACIÓN POR SOBRECUPO (HU-03, RN-02):* Al alcanzar el límite legal (ej. 16/16), el backend responde inmediatamente HTTP 409 Conflict con mensaje `"CAPACIDAD HOMOLOGADA AGOTADA: PROHIBIDO ABORDAJE"`. Cero excepciones o overrides manuales.
  - *DENEGACIÓN POR RUTA INCORRECTA (HU-02):* Denegación si el menor está asignado a otra ruta.
  - *DENEGACIÓN POR QR DUPLICADO (HU-02):* Rechazo de lecturas dobles del mismo QR en un lapso < 15 minutos en el mismo viaje.
  - *DENEGACIÓN POR ESTADO INASISTENTE (HU-02):* Bloqueo si el alumno figura previamente como `Ausente Confirmado`.
- **Criterios de Aceptación (DoD):**
  - [ ] Operación atómica de incremento bajo concurrencia mediante `INCR` en Redis o `SELECT ... FOR UPDATE` en PostgreSQL.
  - [ ] Tiempo de respuesta < 200 ms por escaneo.

---

### `[ISSUE #08] [PASSENGERS] Gestión Transaccional de Pasajeros Ocasionales Condicionada a Inasistencia Previa`
- **Etiquetas:** `passengers`, `business-rules`, `solid:ocp`, `priority:medium`
- **Trazabilidad SRS:** RF-04, HU-04, RN-03.
- **Desglose de Principios SOLID:**
  - **S (Single Responsibility):** `GuestPassengerEligibilityService` verifica la disponibilidad del cupo liberado; `GuestQrGeneratorService` emite el token provisional.
  - **O (Open/Closed):** Sistema de reglas de negocio basado en especificaciones (`ISpecification<GuestRequest>`), extensible a nuevas políticas de colegio sin modificar el controlador.
  - **L (Liskov Substitution):** La especificación de validación de anticipación `TimeWindowSpecification` puede sustituirse por calendarios festivos sin romper la interfaz.
  - **I (Interface Segregation):** Interfaces segregadas: `IGuestBookingRequester` para padres e `IGuestBookingApprover` para directivas.
  - **D (Dependency Inversion):** El caso de uso depende del puerto `ISeatVacancyRepository` para verificar inasistencias sin acoplamiento a tablas concretas.
- **Restricciones y Criterios de Denegación:**
  - *DENEGACIÓN POR FALTA DE CUPO (HU-04, RN-03):* Prohibido aprobar un invitado si no existe al menos una inasistencia formalmente registrada que libere una vacante física.
  - *DENEGACIÓN POR RADICACIÓN TARDÍA (HU-04):* Denegación automática para solicitudes tramitadas con menos de 2 horas de anticipación a la partida del vehículo.
  - *RESTRICCIÓN DE ABORDAJE (HU-04):* El código QR provisional solo se activará si la solicitud figura en estado `APROBADO_COORDINACION`.
- **Criterios de Aceptación (DoD):**
  - [ ] Generación de QR temporal firmado con tiempo de vida (TTL) restringido exclusivamente a la franja horaria del viaje aprobado.

---

### `[ISSUE #09] [CUSTODY-VAULT] Expediente Cifrado (AES-256) de Autorizados y Motor de Alertas Rojas Judiciales`
- **Etiquetas:** `security`, `encryption`, `legal`, `solid:dip`, `priority:critical`
- **Trazabilidad SRS:** RF-05, RF-07, HU-05, HU-07, RN-04, RNF-01, RNF-09.
- **Desglose de Principios SOLID:**
  - **S (Single Responsibility):** `BiometricEncryptionService` gestiona el cifrado/descifrado de material visual y cédulas; `JudicialAlertService` evalúa la existencia de medidas cautelares activas.
  - **O (Open/Closed):** El motor de alertas legales implementa el patrón Chain of Responsibility sobre la interfaz `ILegalRestrictionRule`.
  - **L (Liskov Substitution):** Proveedores de cifrado (`Aes256GcmCryptoProvider` vs `KmsCryptoProvider`) sustituibles bajo la interfaz `ICryptoProvider`.
  - **I (Interface Segregation):** Segregación entre `ICustodyPublicViewer` (para la monitora, datos estrictamente necesarios) e `ICustodyLegalAdministrator` (para Coordinación).
  - **D (Dependency Inversion):** Los casos de uso dependen del puerto `ICustodyVaultRepository`, desacoplados del sistema de archivos o buckets S3.
- **Restricciones y Criterios de Denegación:**
  - *DENEGACIÓN POR FALTA DE CONSENTIMIENTO (HU-05):* Rechazo del registro si el acudiente no firma digitalmente el consentimiento informado (Ley 1581).
  - *RESTRICCIÓN DE ACCESO BIOMÉTRICO (HU-05, RNF-09):* Conductores y terceros tienen absolutamente denegado el acceso o descarga de fotografías del expediente.
  - *DENEGACIÓN ABSOLUTA DE ENTREGA POR ALERTA JUDICIAL (HU-07, RN-04):* El backend bloquea de forma definitiva cualquier opción de entrega si el individuo receptor posee una medida cautelar u orden de alejamiento registrada. Solo Coordinación/Rectoría pueden gestionar dicha orden.
- **Criterios de Aceptación (DoD):**
  - [ ] Datos personales y rutas de imágenes encriptados en base de datos utilizando AES-256-GCM con vector de inicialización único por registro.
  - [ ] Endpoint de verificación de parada que inyecta el flag prioritario `legal_red_alert: true` con leyenda judicial obligatoria.

---

### `[ISSUE #10] [DISEMBARK] Verificación Visual de Desembarque y Protocolo Automatizado de Retorno Seguro`
- **Etiquetas:** `custody`, `delivery`, `safety`, `solid:srp`, `priority:critical`
- **Trazabilidad SRS:** RF-06, RF-08, HU-06, HU-08.
- **Desglose de Principios SOLID:**
  - **S (Single Responsibility):** `DisembarkDeliveryService` valida el match del receptor; `FailedDisembarkProtocol` coordina la contingencia y emisión de alertas de emergencia.
  - **O (Open/Closed):** Los protocolos de contingencia implementan la interfaz `IContingencyProtocol`, permitiendo añadir nuevos flujos (ej. entrega delegada en sede alterna) sin modificar la verificación principal.
  - **L (Liskov Substitution):** Cualquier estrategia de contingencia puede ejecutarse uniformemente respetando el contrato `IContingencyProtocol`.
  - **I (Interface Segregation):** Interfaz segregada `IDisembarkConfirmationPort` que recibe únicamente `{ studentId, authorizedAdultId, stopId, location, timestamp }`.
  - **D (Dependency Inversion):** El caso de uso depende de `ICustodyAuditRepository` y `INotificationDispatcherPort`.
- **Restricciones y Criterios de Denegación:**
  - *DENEGACIÓN DE ENTREGA A DESCONOCIDOS (HU-06):* El backend rechaza peticiones de entrega si el ID del adulto receptor no coincide con alguno de los autorizados registrados en la ficha.
  - *DENEGACIÓN DE ABANDONO DE MENOR (HU-08):* El backend prohíbe taxativamente la existencia de estados o acciones como "Dejado en Parada" o "Descenso sin Tutor".
- **Criterios de Aceptación (DoD):**
  - [ ] Si no se presenta receptor tras 3 minutos de cortesía en parada, el endpoint activa el estado `Retorno Seguro a Sede Escolar`.
  - [ ] Disparo simultáneo de notificación push crítica a los padres y alerta sonora prioritaria en la consola web de Coordinación.

---

## ÉPICA 4: Telemetría GPS, Geocercas, Desvíos y Sincronización Offline

### `[ISSUE #11] [TELEMETRY-INGEST] Pipeline de Telemetría IoT desde Módems GPS Fijos vía Broker MQTT y HTTPS`
- **Etiquetas:** `iot`, `telemetry`, `mqtt`, `solid:dip`, `priority:critical`
- **Trazabilidad SRS:** RF-09, HU-09, RNF-07.
- **Desglose de Principios SOLID:**
  - **S (Single Responsibility):** `MqttTelemetryConsumer` recibe el paquete de red; `TelemetryPacketParser` valida y extrae métricas; `TelemetryPersister` almacena en base de datos.
  - **O (Open/Closed):** Soporte multi-fabricante de módems (Teltonika, Queclink, Suntech) implementando el patrón Factory sobre `ITelemetryDecoder`.
  - **L (Liskov Substitution):** Receptores MQTT y receptores fallback HTTPS implementan la misma interfaz `ITelemetryIngestionChannel`.
  - **I (Interface Segregation):** Segregación en interfaces atómicas: `ITelemetryStreamConsumer`, `ITelemetryHealthChecker`.
  - **D (Dependency Inversion):** El pipeline geoespacial depende del puerto `ITelemetryPublisherPort`, no de la librería MQTT de bajo nivel.
- **Restricciones y Criterios de Denegación:**
  - *RESTRICCIÓN DE CONSUMO DE DATOS PRIVADOS (HU-09, RNF-07):* El backend rechaza cualquier paquete de telemetría proveniente de terminales móviles particulares de conductores. La ingesta es válida **exclusivamente** desde identificadores IMEI/ClientID de hardware vehicular fijo registrado.
- **Criterios de Aceptación (DoD):**
  - [ ] Procesamiento de paquetes cada 5 segundos por unidad (latitud, longitud, velocidad, rumbo, ignición, estado de batería).
  - [ ] Generación automática de alerta de sabotaje si el módem reporta desconexión de alimentación principal y paso a batería de respaldo.

---

### `[ISSUE #12] [GEO-DEVIATION] Algoritmo Geoespacial PostGIS en Streaming para Detección de Desvíos (>300m)`
- **Etiquetas:** `postgis`, `gis`, `algorithms`, `solid:srp`, `priority:high`
- **Trazabilidad SRS:** RF-18, HU-18.
- **Desglose de Principios SOLID:**
  - **S (Single Responsibility):** `RouteDeviationEvaluator` calcula la distancia ortogonal respecto al corredor; la emisión de alarmas es delegada a `AlertDispatcherService`.
  - **O (Open/Closed):** Algoritmos de cálculo de distancia (euclidiana proyectada vs red de malla vial) extensibles mediante `IDistanceCalculationStrategy`.
  - **L (Liskov Substitution):** Cualquier estrategia de cálculo geoespacial sustituye a otra respetando `IDistanceCalculationStrategy`.
  - **I (Interface Segregation):** Interfaz segregada `IRouteCorridorEvaluator` con método único `evaluateDeviation(vehicleCoord, routePolyline): DeviationResult`.
  - **D (Dependency Inversion):** La lógica de negocio depende de la abstracción `ISpatialQueryService`, desacoplada de la implementación SQL `ST_Distance(geography, geography)`.
- **Restricciones y Criterios de Denegación:**
  - *RESTRICCIÓN DE SILENCIAMIENTO OPERATIVO (HU-18):* La supervisión de desvíos corre en un worker backend desvinculado; la tripulación no tiene facultades ni APIs para silenciar o pausar la detección.
- **Criterios de Aceptación (DoD):**
  - [ ] Franja de tolerancia normal: 150 metros.
  - [ ] Disparo de alerta amarilla persistente a la consola central si la unidad supera 300 metros de alejamiento de la polilínea oficial sin parada de contingencia reportada.

---

### `[ISSUE #13] [GEOFENCE-ETA] Motor de Cercas Virtuales y Estimación Predictiva de Arribo (ETA 5-10 min)`
- **Etiquetas:** `postgis`, `eta`, `notifications`, `solid:ocp`, `priority:high`
- **Trazabilidad SRS:** RF-11, HU-11.
- **Desglose de Principios SOLID:**
  - **S (Single Responsibility):** `EtaPredictorService` calcula tiempos en milisegundos según velocidad y distancia; `GeofenceTriggerService` evalúa la entrada a polígonos radiales.
  - **O (Open/Closed):** Algoritmo predictivo de tiempo de viaje extensible mediante `IEtaCalculator` para incorporar modelos de congestión histórica o tráfico en vivo.
  - **L (Liskov Substitution):** Los diferentes modelos de predicción de ETA son intercambiables bajo la misma interfaz.
  - **I (Interface Segregation):** Contrato segregado `IGeofenceEvaluator` con métodos `checkProximity(vehicleId, stopId)`.
  - **D (Dependency Inversion):** El caso de uso depende del puerto `IStopScheduleRepository` y `INotificationPublisherPort`.
- **Restricciones y Criterios de Denegación:**
  - *RESTRICCIÓN DE ENVÍO EXTEMPORÁNEO (HU-11):* El backend suprime el despacho de alertas de proximidad si el vehículo se encuentra detenido por avería o siniestro antes del radio de cobertura.
- **Criterios de Aceptación (DoD):**
  - [ ] Detección del ingreso al radio de geocerca equivalente a 5-10 minutos de distancia.
  - [ ] Disparo automático de evento `ApproachingStopDomainEvent` hacia el motor transaccional de notificaciones push.

---

### `[ISSUE #14] [OFFLINE-SYNC] Endpoint de Sincronización Idempotente FIFO para Puntos Ciegos y Detección de Zonas de Sombra`
- **Etiquetas:** `offline`, `resilience`, `concurrency`, `solid:srp`, `priority:critical`
- **Trazabilidad SRS:** RF-10, RF-14, HU-10, HU-14, RNF-06.
- **Desglose de Principios SOLID:**
  - **S (Single Responsibility):** `OfflineSyncReconciliationService` procesa transacciones encoladas garantizando orden y unicidad; `BlindSpotDetector` monitorea la proximidad a zonas sin señal.
  - **O (Open/Closed):** Abierto a nuevos tipos de eventos offline (asistencias, novedades mecánicas, observaciones de ruta) implementando `ISyncablePayload`.
  - **L (Liskov Substitution):** El motor de procesamiento de lotes maneja colecciones polimórficas de `ISyncablePayload` sin diferenciar el tipo específico de novedad.
  - **I (Interface Segregation):** Segregación entre `ISyncIngestionPort` (procesamiento por lotes) e `IBlindSpotCatalogPort` (consulta de polígonos de sombra).
  - **D (Dependency Inversion):** La persistencia offline reconciliada depende de `ISyncTransactionManager`, abstrayendo la cola transaccional FIFO protegida.
- **Restricciones y Criterios de Denegación:**
  - *DENEGACIÓN DE DESCARTE DE REGISTROS (HU-10, RNF-06):* El motor backend retorna el listado exacto de hashes/UUIDs procesados para que la app cliente solo depure registros con confirmación HTTP 200/201.
  - *RESTRICCIÓN DE FALSA ALARMA EN ZONA DE SOMBRA (HU-14):* Prohibido clasificar la pérdida de telemetría como secuestro o varada si el vehículo está dentro de las coordenadas del polígono ciego homologado (ej. La Virginia).
- **Criterios de Aceptación (DoD):**
  - [ ] Detección automatizada 500 metros antes de entrar al polígono ciego para despachar notificación push preventiva a los acudientes.
  - [ ] Generación de alarma por retraso anómalo en Coordinación si la unidad supera 25 minutos continuos sin señal dentro del polígono.

---

## ÉPICA 5: Streaming en Tiempo Real & Notificaciones

### `[ISSUE #15] [REALTIME-WS] Servidor Socket.IO con Privacidad Diferencial y Salas Segmentadas por Viaje`
- **Etiquetas:** `websockets`, `realtime`, `privacy`, `solid:isp`, `priority:critical`
- **Trazabilidad SRS:** RF-19, HU-19, RN-07, RNF-02.
- **Desglose de Principios SOLID:**
  - **S (Single Responsibility):** `TelemetrySocketGateway` gestiona conexiones y handshake; `RoomAuthorizationManager` gobierna la inclusión/expulsión de sockets según privilegios.
  - **O (Open/Closed):** Soporte de múltiples adaptadores de sockets (Redis Adapter, Postgres CDC) implementando `ISocketBroadcaster`.
  - **L (Liskov Substitution):** Adaptadores de streaming intercambiables sin alterar la lógica de las salas.
  - **I (Interface Segregation):** Segregación en interfaces: `ISocketRoomManager`, `ITelemetryDataBroadcaster`.
  - **D (Dependency Inversion):** Los eventos de telemetría son consumidos desde `ITelemetryEventBus`, no invocados acopladamente por el broker MQTT.
- **Restricciones y Criterios de Denegación:**
  - *DENEGACIÓN POR PRIVACIDAD FAMILIAR (HU-19, RNF-02):* Prohibido a un acudiente visualizar buses donde no viaje su hijo o coordenadas de paraderos ajenos.
  - *DENEGACIÓN DE MAPA FUERA DE HORARIO OPERATIVO (HU-19, RN-07):* El streaming se bloquea y desconecta automáticamente para el acudiente si su hijo figura en estado `En Casa / Espera` o `Entregado a Adulto Autorizado`.
  - *DENEGACIÓN DE VISUALIZACIÓN GLOBAL (HU-19):* La sala de monitoreo global (`fleet:global`) es denegada a todo usuario que no posea rol directivo (`SUPERADMIN_COORDINADORA` o `ADMIN_EMPRESA`).
- **Criterios de Aceptación (DoD):**
  - [ ] Integración de Socket.IO con `@socket.io/redis-adapter` para alta disponibilidad.
  - [ ] Payload sanitizado antes de la emisión a salas familiares: `{ busLat, busLon, speed, routePolyline, assignedStop }`.

---

### `[ISSUE #16] [NOTIFICATIONS] Despachador Transaccional de Notificaciones Push (FCM) con Fallback SMS`
- **Etiquetas:** `notifications`, `push`, `fcm`, `sms`, `solid:ocp`, `solid:lsp`, `priority:high`
- **Trazabilidad SRS:** RF-12, RF-20, HU-12, HU-20, RNF-05.
- **Desglose de Principios SOLID:**
  - **S (Single Responsibility):** `NotificationDispatcher` orquesta el despacho; `FcmPushChannel` maneja la conexión con Firebase; `TwilioSmsChannel` maneja el fallback por SMS.
  - **O (Open/Closed):** **OCP al 100%.** Se utiliza el patrón Strategy: `INotificationChannel` es implementado por canales individuales. Añadir WhatsApp o Email solo requiere una nueva clase sin modificar el orquestador.
  - **L (Liskov Substitution):** **LSP al 100%.** Cualquier canal cumple el contrato `send(recipient, message): Promise<NotificationResult>`. El despachador conmuta a SMS sin cambiar de firma.
  - **I (Interface Segregation):** Interfaces segregadas: `ITransactionalNotifier`, `IBulkMessageBroadcaster`.
  - **D (Dependency Inversion):** Los casos de uso inyectan `INotificationDispatcherPort`, ignorando los SDKs de Firebase o Twilio.
- **Restricciones y Criterios de Denegación:**
  - *DENEGACIÓN DE SILENCIAMIENTO DE ALERTAS CRÍTICAS (HU-20):* Notificaciones marcadas como críticas (`Alerta de Custodia`, `Desembarque Fallido`, `Retorno Seguro`) deben enviarse con prioridad máxima (`high_priority: true`) y canal no silenciable.
  - *DENEGACIÓN DE DISPARO CRUZADO (HU-20):* Bloqueo estricto del envío de avisos hacia dispositivos no vinculados formalmente en el expediente del menor.
  - *RESTRICCIÓN DE CHATS ABIERTOS BIDIRECCIONALES (HU-12):* El backend prohíbe endpoints de mensajería libre entre familias y tripulación.
- **Criterios de Aceptación (DoD):**
  - [ ] Encolamiento asíncrono con BullMQ asegurando latencia de entrega < 2.5 segundos (RNF-05).
  - [ ] Fallback automático a SMS transaccional si FCM retorna error o token caducado.

---

## ÉPICA 6: Auditoría Forense & Reportes Oficiales

### `[ISSUE #17] [FORENSIC-AUDIT] Bitácora Criptográfica Inmutable (SHA-256) y Exportador de Reportes Probatorios (PDF/Excel)`
- **Etiquetas:** `audit`, `security`, `reporting`, `solid:srp`, `solid:dip`, `priority:high`
- **Trazabilidad SRS:** RF-16, HU-16, RNF-08.
- **Desglose de Principios SOLID:**
  - **S (Single Responsibility):** `ForensicLogService` sella y persiste eventos encadenados; `ReportExportService` genera documentos en PDF/Excel con plantillas oficiales.
  - **O (Open/Closed):** Motor de reportes extensible mediante la interfaz `IReportFormatter` (soporte para PDF, XLSX, CSV forense).
  - **L (Liskov Substitution):** Todos los generadores de formato implementan idénticamente `IReportFormatter`.
  - **I (Interface Segregation):** Segregación entre `IAuditLogWriter` (solo append de registros) e `IAuditLogReader` (consultas y filtros directivos).
  - **D (Dependency Inversion):** Los casos de auditoría dependen de la abstracción `IForensicAuditStore`, desacoplada de la base de datos subyacente.
- **Restricciones y Criterios de Denegación:**
  - *RESTRICCIÓN DE ALTERACIÓN HISTÓRICA (HU-16, RNF-08):* Los registros no admiten mutación ni borrado físico. Se garantiza integridad con disparadores en base de datos (`BEFORE UPDATE OR DELETE RAISE EXCEPTION`).
- **Criterios de Aceptación (DoD):**
  - [ ] Cada fila incluye un `integrity_hash` calculado como:
    `SHA256(previous_hash + timestamp + event_type + actor_id + payload_json)`.
  - [ ] Generación de reportes PDF firmados con sello digital oficial institucional, exportables por rango de fechas, vehículo y ruta.
