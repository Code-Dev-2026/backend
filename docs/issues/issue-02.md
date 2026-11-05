# Issue #2: feat(db): setup base de datos PostgreSQL 16 + PostGIS y migraciones DDL V001-V010
**Etiqueta:** requirement

### Contexto
El sistema requiere una base de datos relacional de grado empresarial con capacidades geoespaciales nativas para modelar paradas, rutas, geocercas y telemetría de vehículos escolares en Pereira.

### Objetivo
Desplegar y estructurar las 10 migraciones numeradas en PostgreSQL 16 + PostGIS 3.4 (`db/migrations/V001__...sql` a `V010__...sql`), configurando roles de privilegios mínimos, tipos nativos sin casts y restricciones de integridad referencial.

### Alcance
- **Incluye:** Extensiones PostGIS, pgcrypto, btree_gist; 4 roles de DB (`app_owner`, `app_user`, `app_user_operations`, `app_user_billing`); tipos `geography(Point,4326)` con índices GiST directos; particionamiento mensual de `registro_gps`; esquema segregado `billing`.
- **No incluye:** Lógica de controllers o servicios REST (pertenecen a sprints posteriores).

### Requisitos SRS v2.0
- RNF-01 (Seguridad e Integridad), RNF-02 (Aislamiento Multi-rol), RNF-03 (Auditoría Forense), RNF-05 (Rendimiento Geoespacial).
- Migraciones DDL Flyway-compatible y particiones automáticas por rango de fecha.

### Tablas Involucradas
- Todas las tablas del esquema `public` (39 tablas) y `billing` (3 tablas) creadas mediante V001 a V010.

### Criterios de Aceptación
- **Dado** un servidor PostgreSQL 16 con extensión PostGIS 3.4,
- **Cuando** se ejecutan secuencialmente las migraciones V001 a V010,
- **Entonces** todas las tablas, vistas, funciones y triggers se crean sin errores de sintaxis y los roles quedan asignados con los permisos mínimos requeridos.

### Tareas Técnicas
- [ ] Configuración de extensiones `postgis`, `pgcrypto` y `btree_gist` (V001).
- [ ] Definición de roles de base de datos sin credenciales quemadas (V001, V010).
- [ ] Creación de tablas de identidad, rutas, viajes, custodia y telemetría (V002-V007).
- [ ] Implementación de triggers de inmutabilidad y encadenamiento SHA-256 (V008).
- [ ] Creación del esquema aislado `billing` (V009).

### Principio SOLID Aplicado y Verificación
- **SRP (Single Responsibility Principle):** Cada archivo de migración gestiona un único sub-dominio acotado (identidad, geo, viajes, custodia, auditoría, facturación). Verificado por la independencia y secuencialidad de scripts.

### Criterios de Seguridad
- OWASP ASVS V1.14 (Separación de privilegios de DB). Conexión operativa sin permisos DDL (`app_user` no posee permisos de `app_owner`).

### Verificación Técnica
- Ejecución secuencial de los scripts de migración `db/migrations/V001__...sql` a `V010__...sql` mediante cliente `psql` contra PostgreSQL 16 local con código de salida 0.

### Dependencias
- Depende de: Issue #1.
- Bloquea a: Todos los issues subsiguientes (#3 a #20).

### Definición de Hecho (DoD)
- Migraciones ejecutadas localmente con código de salida 0, esquemas validados y roles configurados sin excepciones.

### Estimación
- 5 Puntos de Historia (3 días).
