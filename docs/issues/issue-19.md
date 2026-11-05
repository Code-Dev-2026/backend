# Issue #19: feat(security): políticas de Row-Level Security (RLS) y hardening de privilegios mínimos ASVS L2
**Etiqueta:** requirement

### Contexto
En una aplicación de transporte escolar, la falla de aislamiento de datos (IDOR o fuga multi-tenant) expondría la ubicación e identidad de menores a personas no autorizadas.

### Objetivo
Implementar y verificar las políticas de Row-Level Security (RLS) en PostgreSQL 16 para aislar estrictamente el acceso de los acudientes a sus propios hijos y condicionar el acceso a la telemetría en vivo, junto con el hardening integral de cabeceras, límites de tasa y validación de entrada.

### Alcance
- **Incluye:** Políticas RLS forzadas (`FORCE ROW LEVEL SECURITY`) en `estudiante`, `registro_gps`, `notificacion`, `billing.cartera`; contexto de sesión `app.current_user_id` y `app.current_user_role`; Helmet, CORS restrictivo, Rate Limiting por IP/Usuario; deshabilitación de `x-powered-by`.
- **No incluye:** RLS por colegio (es una sola institución: Colegio San Benito del Otún).

### Requisitos SRS v2.0
- RNF-01 (Seguridad Integral ASVS L2), RNF-02 (Aislamiento de Información por Acudiente y Rol).
- [PROPUESTA] Contexto de variables de sesión en PostgreSQL seteado mediante middleware transaccional en cada petición.

### Tablas Involucradas
- `estudiante`, `registro_gps`, `notificacion`, `billing.cartera`, `billing.factura`.

### Criterios de Aceptación
- **Dado** un acudiente autenticado con id `U-01`,
- **Cuando** realiza un `SELECT * FROM estudiante`,
- **Entonces** la base de datos retorna únicamente los registros de sus propios hijos biológicos o representados, filtrando cualquier otro menor de la institución sin importar los parámetros de la consulta.

### Tareas Técnicas
- [ ] Middleware de base de datos para ejecutar `SET LOCAL app.current_user_id = ...` y rol en cada transacción.
- [ ] Verificación de políticas RLS forzadas en PostgreSQL (V010).
- [ ] Configuración de Helmet, CORS y Rate Limiting en `main.ts` de NestJS.
- [ ] Auditoría de seguridad de cabeceras HTTP y prevención de inyecciones NoSQL/SQLi.

### Principio SOLID Aplicado y Verificación
- **SRP:** `SecurityContextMiddleware` tiene la única responsabilidad de trasladar el contexto de identidad verificado hacia el motor de persistencia.

### Criterios de Seguridad
- OWASP ASVS V1.1 (Arquitectura segura), V4.1 (Control de acceso a nivel de fila - RLS), V14.4 (Configuración segura de cabeceras HTTP).

### Verificación Automática
- Pruebas de integración intentando acceder a registros de otros usuarios (pruebas anti-IDOR en endpoints de estudiantes y facturas).

### Dependencias
- **Depende de:** Issue #2 (Setup DB), Issue #3 (Auth/Roles), Issue #4 (Estudiantes), Issue #12 (Telemetría), Issue #18 (Billing).
- **Bloquea a:** Issue #20 (E2E Tests).

### Definición de Hecho (DoD)
- RLS verificado con pruebas automatizadas y escaneo de vulnerabilidades sin hallazgos altos/críticos.

### Riesgos y Mitigaciones
- **Riesgo:** Olvido de setear la variable de sesión en peticiones sin autenticar.
- **Mitigación:** Políticas RLS con denegación por defecto si `app.current_user_id` es nulo o vacío.

### Estimación
- 3 Puntos de Historia (2 días).
