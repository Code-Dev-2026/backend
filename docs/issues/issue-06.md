# Issue #6: feat(geo): modelado geoespacial de rutas escolares, paradas GiST y geocercas en PostGIS
**Etiqueta:** requirement

### Contexto
El cálculo de trayectorias, distancias a paradas y detección de salidas de zonas seguras en el perímetro de Pereira requiere un modelo geoespacial estricto sobre coordenadas WGS84.

### Objetivo
Implementar los servicios y endpoints de administración de rutas (`ruta`), paradas oficiales (`parada` con tipos nativos `geography(Point,4326)`) y geocercas de zonas urbanas/rurales (`zona_geografica`), con validación de asignaciones biunívocas de estudiantes a paradas de la misma ruta.

### Alcance
- **Incluye:** CRUD de rutas escolares; orden secuencial de paradas; cálculo de distancias geodésicas vía `ST_Distance`; polígonos de zonas de cobertura; verificación de integridad referencial compuesta en `asignacion_ruta`.
- **No incluye:** Algoritmos de ruteo dinámico con tráfico en tiempo real (las rutas son troncales fijas aprobadas por la Secretaría de Tránsito).

### Requisitos SRS v2.0
- RF-03 (Configuración de Rutas y Paradas Oficiales), RF-04 (Asignación de Estudiantes a Rutas), RNF-05 (Eficiencia en Búsquedas Espaciales).
- [PROPUESTA] Índices espaciales GiST directos sobre geometrías nativas y validación de paradas dentro del recorrido.

### Tablas Involucradas
- `colegio`, `ruta`, `parada`, `zona_geografica`, `asignacion_ruta`.

### Criterios de Aceptación
- **Dado** un estudiante asignado a la ruta `R-01`,
- **Cuando** se intenta asociarle una parada de subida perteneciente a la ruta `R-02`,
- **Entonces** la base de datos rechaza la operación por violación de clave foránea compuesta `(id_ruta, id_parada)`.

### Tareas Técnicas
- [ ] Endpoints de gestión de rutas y paradas con coordenadas GeoJSON.
- [ ] Repositorio PostGIS con consultas optimizadas con índices GiST (`ST_DWithin`, `ST_Contains`).
- [ ] Servicio de validación de asignación de ruta para garantizar coherencia estudiante-parada.
- [ ] Configuración de la geocerca de la sede del Colegio San Benito del Otún.

### Principio SOLID Aplicado y Verificación
- **ISP (Interface Segregation Principle):** Interfaces de consulta espacial segregadas (`IGeoProximityQueries`, `IRouteDefinitionService`) para no acoplar casos de uso logísticos a funciones complejas GIS.

### Criterios de Seguridad
- OWASP ASVS V5.1 (Validación estricta de rangos geográficos: latitud [-90, 90], longitud [-180, 180]).

### Verificación Automática
- Pruebas de integración validando cálculos de proximidad contra coordenadas reales del municipio de Pereira.

### Dependencias
- **Depende de:** Issue #1 (Scaffold NestJS), Issue #2 (PostgreSQL 16 + PostGIS 3.4).
- **Bloquea a:** Issues #7, #11, #12, #13.

### Definición de Hecho (DoD)
- Endpoints documentados en Swagger/OpenAPI con formatos GeoJSON y pruebas espaciales aprobadas.

### Riesgos y Mitigaciones
- **Riesgo:** Degradación de rendimiento en consultas espaciales concurrentes.
- **Mitigación:** Empleo estricto de columnas `geography` indexadas con GiST sin conversiones dinámicas en cláusula WHERE.

### Estimación
- 5 Puntos de Historia (3 días).
