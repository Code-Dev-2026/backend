# Issue #23: ci(e2e): automatización de ejecución de suite E2E y publicación de reportes de cobertura en GitHub Actions
**Etiqueta:** automation

### Contexto
La verificación de las invariantes de negocio y pruebas E2E requiere ejecución desatendida y generación de métricas de cobertura en la integración continua.

### Relación
- Relacionada con #20.

### Objetivo
Automatizar en GitHub Actions la ejecución de `npm run test:e2e`, la ejecución de `psql -f db/tests/test_suite_camino_seguro.sql` y la generación de reportes de cobertura.

### Alcance
- **Incluye:** Pipeline de GitHub Actions ejecutando `npm run test:e2e` y `test_suite_camino_seguro.sql`; automatización de la generación de reportes de cobertura en GitHub Actions.
- **No incluye:** Lógica interna ni aserciones de negocio de las pruebas E2E o DDL.

### Criterios de Aceptación
- **Dado** un cambio integrado en el repositorio,
- **Cuando** se dispara el pipeline de GitHub Actions,
- **Entonces** ejecuta la suite E2E, la suite SQL de pruebas y genera el reporte de cobertura correspondiente.

### Tareas Técnicas
- [ ] Configuración del step de ejecución de `npm run test:e2e` en GitHub Actions.
- [ ] Configuración del step de ejecución de `psql -f db/tests/test_suite_camino_seguro.sql` en GitHub Actions.
- [ ] Automatización de la generación de reportes de cobertura en GitHub Actions.
- [ ] Certificación de que el estado de validación local y en CI coincida con los estándares requeridos.

### Verificación Automatizada
- Ejecución de `npm run test:e2e` y `psql -f db/tests/test_suite_camino_seguro.sql` en el pipeline de GitHub Actions con 100% de los tests pasando en verde.

### Dependencias
- Relacionada con #20.

### Definición de Hecho (DoD)
- 100% de los tests pasando en verde en GitHub Actions y reporte de cobertura generado.

### Estimación
- [PENDIENTE: estimación de puntos].
