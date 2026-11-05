# Issue #22: ci(db): workflow de verificación automatizada de migraciones DDL y extensiones PostGIS en GitHub Actions
**Etiqueta:** automation

### Contexto
Las migraciones DDL de base de datos requieren verificación automatizada sobre un entorno con PostgreSQL 16 y PostGIS 3.4.

### Relación
- Relacionada con #2.

### Objetivo
Configurar el contenedor de prueba y workflow CI en `.github/workflows/ci.yml` fijando la imagen Docker estrictamente en PostgreSQL 16 con PostGIS 3.4 para ejecutar y validar las migraciones DDL V001 a V010.

### Alcance
- **Incluye:** Workflow CI en `.github/workflows/ci.yml`; configuración del servicio `postgis/postgis:16-3.4`; ejecución automática de las migraciones DDL V001 a V010.
- **No incluye:** Definición del modelo de datos de negocio, lógica de controladores NestJS ni la suite de pruebas de invariantes de negocio (gestionada en issue independiente de testing E2E).

### Criterios de Aceptación
- **Dado** un cambio en los scripts DDL o en el repositorio,
- **Cuando** se ejecuta el workflow de GitHub Actions,
- **Entonces** levanta el servicio `postgis/postgis:16-3.4`, ejecuta las migraciones DDL V001 a V010 secuencialmente y valida la creación de esquemas y tablas con código de salida 0.

### Tareas Técnicas
- [ ] Configuración del contenedor de prueba y workflow CI en `.github/workflows/ci.yml`.
- [ ] Configuración del servicio `postgis/postgis:16-3.4`.
- [ ] Ejecución automática de las migraciones DDL V001 a V010 en el workflow.

### Verificación Automatizada
- Ejecución automática de las migraciones DDL V001 a V010 en GitHub Actions bajo servicio `postgis/postgis:16-3.4` con código de salida 0.

### Dependencias
- Relacionada con #2.

### Definición de Hecho (DoD)
- Migraciones ejecutadas en CI con código de salida 0 bajo la imagen oficial de PostgreSQL 16 + PostGIS 3.4.

### Estimación
- [PENDIENTE: estimación de puntos].
