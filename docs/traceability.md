# Matriz de Trazabilidad — Issues #1 a #9

Trazabilidad entre los issues implementados y cerrados en `develop` (Sprints 0, 1 y 2), los módulos del backend y su documentación técnica.

> **Fuera de alcance:** los issues `#10`, `#11` y `#12` (y posteriores) no forman parte de esta entrega documental.

## Tabla Issue → Módulo → Documento

| Issue | Sprint | Título resumido | Módulo(s) en código | Documento(s) | Estado |
| --- | --- | --- | --- | --- | --- |
| `#1` | Sprint 0 | Orquestación general y arquitectura del backend | `src/main.ts`, `src/app.module.ts`, `src/config/`, `src/common/` | [README.md](../README.md), [backend-blueprint.md](architecture/backend-blueprint.md), [ADR-001](adr/ADR-001-arquitectura-hexagonal.md), [ADR-002](adr/ADR-002-inmutabilidad-criptografica-worm.md) | Documentado |
| `#2` | Sprint 0 | Base de datos PostgreSQL 16 + PostGIS y migraciones V001–V010 | `db/migrations/V001`–`V010`, `db/docker-compose.yml`, `docker/postgres/`, `db/scripts/` | [database-migrations.md](modules/database-migrations.md), [README.md](../README.md) | Documentado |
| `#3` | Sprint 1 | Autenticación JWT con rotación, RBAC y MFA | `src/modules/auth/`, `src/modules/mailer/`, `src/common/guards/` | [auth.md](modules/auth.md) | Documentado |
| `#4` | Sprint 1 | Criptovault AES-256-GCM y Blind Indexing | `src/common/crypto/`, `src/common/security/`, `src/modules/students/`, `db/migrations/V011` | [crypto-vault.md](modules/crypto-vault.md) | Documentado |
| `#5` | Sprint 1 | Importación masiva de matrículas | `src/modules/students/import/`, `db/migrations/V012` | [enrollment-import.md](modules/enrollment-import.md) | Documentado |
| `#6` | Sprint 2 | Modelado geoespacial, rutas, paradas y geocercas | `src/modules/routes/`, `db/migrations/V013` | `docs/modules/geo.md` | Pendiente (Etapa Sprint 2) |
| `#7` | Sprint 2 | Custodia física: máquina de estados FSM y WORM | `src/modules/custody/`, `db/migrations/V014` | `docs/modules/custody.md` | Pendiente (Etapa Sprint 2) |
| `#8` | Sprint 2 | Abordaje QR atómico y prevención de sobrecupo | `src/modules/attendance/`, `db/migrations/V015` | `docs/modules/qr-boarding.md` | Pendiente (Etapa Sprint 2) |
| `#9` | Sprint 2 | Receptores de entrega, desembarque y retorno seguro | `src/modules/attendance/`, `db/migrations/V016` | `docs/modules/delivery-recipients.md` | Pendiente (Etapa Sprint 2) |

---

## Puertos Hexagonales Reales (`src/common/ports/`)

Complementando [backend-blueprint.md](architecture/backend-blueprint.md) (que lista 6 puertos), el núcleo transversal implementa actualmente **8 interfaces de dominio** en `src/common/ports/`:

1. `IRepository` (`repository.port.ts`)
2. `ICryptoVaultPort` (`crypto-vault.port.ts`)
3. `IAuditLedgerPort` (`audit-ledger.port.ts`)
4. `IEventDispatcherPort` (`event-dispatcher.port.ts`)
5. `ITelemetryIngestionPort` (`telemetry-ingestion.port.ts`)
6. `ICustodyFsmPort` (`custody-fsm.port.ts`)
7. `INotificationSenderPort` (`notification-sender.port.ts`)
8. `IBillingIsolationPort` (`billing-isolation.port.ts`)
