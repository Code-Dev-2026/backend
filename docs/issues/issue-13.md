# Issue #13: feat(geo): motor de detección de desvíos de ruta (>300m) y paradas prolongadas en streaming
**Etiqueta:** requirement

### Contexto
Para garantizar la integridad física de la ruta, el sistema debe vigilar activamente que el conductor no abandone el trazado vial aprobado ni se detenga de forma injustificada en zonas no autorizadas.

### Objetivo
Desarrollar el motor de análisis espacial en streaming que calcula la distancia perpendicular del vehículo al trazado de la ruta (`ST_Distance`) y genera alertas automáticas si se desvía más de 300 metros o permanece inmóvil fuera de parada por más de 5 minutos.

### Alcance
- **Incluye:** Cálculo geodésico PostGIS; detector de desvío significativo (> 300 m); detector de detención prolongada (> 5 min a velocidad < 3 km/h fuera de geocerca de parada); emisión inmediata de incidente de seguridad.
- **No incluye:** Análisis predictivo de accidentes.

### Requisitos SRS v2.0
- RF-15 (Detección de Desvíos de Ruta y Alertas de Seguridad), RNF-05 (Procesamiento Geoespacial Inmediato).
- [PROPUESTA] Umbral de advertencia preventiva a los 150 metros y alerta crítica a los 300 metros (documentado en supuestos).

### Tablas Involucradas
- `viaje`, `ruta`, `registro_gps`, `parada`, `incidente`, `notificacion`.

### Criterios de Aceptación
- **Dado** un vehículo que transita por una vía alterna ubicada a 350 metros de la polilínea oficial de la ruta `R-01`,
- **Cuando** se procesa la última coordenada GPS,
- **Entonces** el motor detecta la infracción, registra un `incidente` tipo `DESVIO_RUTA_SIGNIFICATIVO` y despacha una alerta crítica a Coordinación.

### Tareas Técnicas
- [ ] Servicio `GeoDeviationAnalyzer` con caching de la polilínea simplificada de la ruta.
- [ ] Consulta espacial optimizada `ST_DWithin` contra el buffer de la ruta.
- [ ] Algoritmo de detección de inmovilidad basado en ventana de tiempo de las últimas 10 lecturas GPS.
- [ ] Generación automática de incidentes y notificaciones push de urgencia.

### Principio SOLID Aplicado y Verificación
- **OCP:** Los detectores (`RouteDeviationDetector`, `ProlongedStopDetector`, `SpeedingDetector`) implementan `ITelemetryAnomalyRule`, permitiendo añadir nuevos chequeos sin tocar el flujo de procesamiento de telemetría.

### Criterios de Seguridad
- OWASP ASVS V1.14 (Registro inviolable de anomalías y desviaciones de seguridad física).

### Verificación Automática
- Pruebas unitarias con secuencias de coordenadas pre-grabadas (rutas normales vs rutas desviadas).

### Dependencias
- **Depende de:** Issue #6 (Rutas GiST), Issue #12 (Telemetría IoT).
- **Bloquea a:** Issue #15 (Notificaciones).

### Definición de Hecho (DoD)
- Tiempo de evaluación de desvío < 100 ms por coordenada y alertas generadas con exactitud.

### Riesgos y Mitigaciones
- **Riesgo:** Falsos positivos por derivas momentáneas del sensor GPS en cañones urbanos.
- **Mitigación:** Exigir al menos 3 lecturas consecutivas confirmadas fuera del umbral antes de disparar la alerta crítica.

### Estimación
- 5 Puntos de Historia (3 días).
