# Blueprint de Arquitectura y Orquestación Backend — Camino Seguro

Este documento detalla la orquestación integral, contratos transversales y cronograma modular para los 5 Sprints del backend de "Camino Seguro", bajo los principios SOLID, Arquitectura Hexagonal y seguridad ASVS L2.

---

## 1. Mapa de Sprints y Distribución de Issues

```
                                  +------------------------------------+
                                  |              ISSUE #1              |
                                  |    Épica de Orquestación General   |
                                  +-----------------+------------------+
                                                    |
             +--------------------+-----------------+--------------------+--------------------+
             |                    |                                      |                    |
             v                    v                                      v                    v
      [ SPRINT 0 ]         [ SPRINT 1 ]                           [ SPRINT 2 ]         [ SPRINT 3 ]
     Fundaciones e         Identidad &                            Operación &         Telemetría &
     Infraestructura        Expedientes                             Custodia            Streaming
     - Issue #2 (DB)       - Issue #3 (Auth JWT/MFA)              - Issue #6 (Geo)     - Issue #11 (Pasajeros)
                           - Issue #4 (Vault AES/Blind)           - Issue #7 (FSM)     - Issue #12 (MQTT)
                           - Issue #5 (Matrículas Masivas)        - Issue #8 (QR)      - Issue #13 (Desvíos)
                                                                  - Issue #9 (Receptor)- Issue #14 (WebSocket)
                                                                  - Issue #10 (Alertas)- Issue #15 (Push)
                                                                                              |
                                                                                              v
                                                                                       [ SPRINT 4 ]
                                                                                       Auditoría &
                                                                                       Segregación
                                                                                       - Issue #16 (Offline)
                                                                                       - Issue #17 (WORM Audit)
                                                                                       - Issue #18 (Billing)
                                                                                       - Issue #19 (RLS Hardening)
                                                                                       - Issue #20 (E2E Tests)
                                                                                       - Issues #21-#23 (CI/CD)
```

---

## 2. Inversión de Dependencias (DIP) y Contratos de Dominio

Los módulos desacoplan su lógica central mediante interfaces y abstracciones expuestas en la capa transversal (`src/common/ports/`):

| Puerto / Contrato | Interfaz de Dominio | Adaptador Concreto |
|---|---|---|
| Criptografía y Vault | `ICryptoVaultPort` | `AesEncryptionService` + `BlindIndexService` |
| Bitácora Forense | `IAuditLedgerPort` | `AuditService` (PostgreSQL WORM Trigger) |
| Ingesta de Telemetría | `ITelemetryIngestionPort` | Broker MQTT (`TelemetryController`) |
| Despacho en Tiempo Real | `INotificationSenderPort` | Pasarela WebSocket Socket.IO + FCM Push |
| Máquina de Estados de Custodia | `ICustodyFsmPort` | `CustodyService` con validación de transiciones |
| Aislamiento de Facturación | `IBillingIsolationPort` | `BillingIsolationService` (Esquema segregado `billing`) |

---

## 3. Matriz de Roles y Principio de Privilegios Mínimos

Conforme al SRS RF-13 y migración V002, se configuran 8 perfiles de usuario autenticados con JWT firmado en RS256/HS256 y rotación de `family_id`:
1. `COORDINADORA_CONVIVENCIA`: Máxima autoridad operativa, gestión de excepciones y custodias (MFA requerido).
2. `RECTORIA`: Consulta ejecutiva y carga de medidas cautelares / alertas judiciales.
3. `GERENCIA_TRANSPORTE`: Administración de contratos y vehículos de la empresa transportadora.
4. `JEFE_OPERACIONES`: Planificación de rutas, asignación de conductores y monitoras.
5. `ADMINISTRADOR_CARTERA`: Acceso restringido exclusivamente al esquema segregado `billing` (inmunidad operativa del alumno).
6. `MONITORA`: Operación en cabina, escaneo QR de abordaje/desembarque y validación biométrica de receptores.
7. `CONDUCTOR`: Navegación en ruta, sin acceso a expedientes sensibles de menores.
8. `ACUDIENTE`: Consulta en vivo del viaje de sus hijos protegidos (Row-Level Security multi-tenant familiar).

