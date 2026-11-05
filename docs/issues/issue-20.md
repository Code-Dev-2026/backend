# Issue #20: test(e2e): suite integral de verificación de invariantes de negocio y pruebas E2E
**Etiqueta:** requirement

### Contexto
Antes de la puesta en marcha operativa, el backend debe certificar que todas las invariantes de negocio del SRS v2.0 se cumplen de forma matemática e inalterable bajo condiciones de concurrencia y estrés.

### Objetivo
Consolidar y ejecutar la suite integral de pruebas de base de datos (`db/tests/test_suite_camino_seguro.sql`) y pruebas E2E en NestJS con Supertest que validan doble escaneo, control de sobrecupo, cadena de custodia, inmutabilidad y cálculo de desvíos.

### Alcance
- **Incluye:** Escenarios 1 al 6 de la suite SQL (Abordaje normal, Sobrecupo, Doble escaneo, Integridad de custodia, Descenso y Bitácora forense); pruebas E2E con Supertest sobre endpoints REST y WebSockets en entorno de pruebas local.
- **No incluye:** Pruebas de usabilidad en dispositivos físicos de usuario final.

### Requisitos SRS v2.0
- Todos los RF y RN del sistema; RNF-01 a RNF-08.
- Suite de pruebas ejecutable directamente con `psql -f db/tests/test_suite_camino_seguro.sql` con assertions automáticas (`ASSERT`).

### Tablas Involucradas
- Totalidad de tablas del sistema en esquemas `public` y `billing`.

### Criterios de Aceptación
- **Dado** un entorno de integración con PostgreSQL 16 y PostGIS 3.4,
- **Cuando** se ejecuta `psql -f db/tests/test_suite_camino_seguro.sql`,
- **Entonces** se ejecutan todas las aserciones con éxito y se emite el mensaje final de confirmación dentro de un bloque transaccional con `ROLLBACK` obligatorio sin ninguna excepción no controlada.
- **Dado** el servidor NestJS iniciado en modo de test,
- **Cuando** se ejecutan las pruebas E2E con `npm run test:e2e`,
- **Entonces** los flujos críticos de autenticación, abordaje QR, desembarque y auditoría responden con los códigos de estado y payloads esperados.

### Tareas Técnicas
- [ ] Ejecución y depuración de la suite SQL contra el contenedor oficial de PostGIS.
- [ ] Implementación de pruebas E2E en NestJS con Jest/Supertest para los flujos críticos de abordaje y entrega.
- [ ] Verificación de aislamiento transaccional con rollback obligatorio para garantizar idempotencia en la ejecución de pruebas.

### Principio SOLID Aplicado y Verificación
- **LSP y SRP:** Cada prueba evalúa un contrato específico de caso de uso de manera aislada con pre-condiciones limpias y rollback al finalizar.

### Criterios de Seguridad
- OWASP ASVS V1.1 (Verificación completa de controles de seguridad y restricciones de acceso).

### Verificación Técnica
- Ejecución local de `npm run test:e2e` y `psql -f db/tests/test_suite_camino_seguro.sql` pasando con código de salida 0.

### Dependencias
- Depende de: Issues #2 a #19.

### Definición de Hecho (DoD)
- 100% de los tests pasando en verde localmente y reporte de aserciones de invariantes ejecutado sin excepciones.

### Estimación
- 5 Puntos de Historia (3 días).
