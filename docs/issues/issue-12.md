# Issue #12: feat(telemetry): ingesta de telemetría IoT vehicular vía broker MQTT y almacenamiento particionado
**Etiqueta:** requirement

### Contexto
Cada microbús escolar cuenta con un módem GPS o dispositivo móvil que emite coordenadas geográficas periódicas cada pocos segundos. El backend debe ingerir miles de puntos por minuto sin saturar la base de datos transaccional.

### Objetivo
Implementar el suscriptor MQTT de telemetría vehicular (`telemetry/vehicles/+/gps`), validación de paquetes telemáticos, almacenamiento en la tabla particionada mensualmente `registro_gps` y reenrutamiento hacia el bus de eventos en memoria.

### Alcance
- **Incluye:** Suscriptor MQTT TLS; validación de paquete (lat, lon, velocidad, precisión, rumbo, odómetro); inserción en lote en `registro_gps`; job de mantenimiento de particiones de 180 días de retención; endpoint de ingesta HTTPS como fallback.
- **No incluye:** Calibración de hardware vehicular en campo.

### Requisitos SRS v2.0
- RF-10 (Seguimiento Satelital en Tiempo Real), RNF-05 (Latencia de Telemetría < 2.5s).
- [PROPUESTA] Particionamiento mensual por rango de fecha en PostgreSQL 16 y política de retención de 180 días.

### Tablas Involucradas
- `viaje`, `vehiculo`, `registro_gps` (tabla particionada y sub-particiones mensuales).

### Criterios de Aceptación
- **Dado** un paquete telemático publicado en el broker MQTT por el vehículo `WKK123`,
- **Cuando** el suscriptor de NestJS recibe el mensaje en formato JSON,
- **Entonces** lo valida, lo almacena en la partición correspondiente al mes en curso y lo entrega al despachador de eventos en < 500 ms.

### Tareas Técnicas
- [ ] Adaptador de infraestructura `MqttTelemetrySubscriber` con reconexión automática.
- [ ] Validador de paquetes telemáticos con descarte de lecturas con baja precisión GPS (> 30 m).
- [ ] Repositorio con `COPY` o inserciones batch optimizadas en `registro_gps`.
- [ ] Integración con la función `fn_crear_particion_gps_mensual`.

### Principio SOLID Aplicado y Verificación
- **DIP:** El servicio de telemetría depende de `ITelemetryIngestPort`, permitiendo recibir datos desde MQTT, HTTP o un simulador sin alterar el procesador.

### Criterios de Seguridad
- OWASP ASVS V10.3 (Autenticación mutua TLS/MQTTS y credenciales de dispositivos restringidas a tópicos propios).

### Verificación Automática
- Prueba de carga simulando 10 vehículos emitiendo coordenadas cada 3 segundos durante 5 minutos en entorno de prueba.

### Dependencias
- **Depende de:** Issue #2 (Migración V007 registro_gps), Issue #6 (Rutas y geocercas).
- **Bloquea a:** Issues #13, #14.

### Definición de Hecho (DoD)
- Ingesta probada con 1,000 puntos/minuto sin pérdida de paquetes y particionamiento activo.

### Riesgos y Mitigaciones
- **Riesgo:** Pérdida de conectividad con el broker MQTT.
- **Mitigación:** Mecanismo de fallback a endpoint REST `/telemetria/gps` en el firmware/app vehicular.

### Estimación
- 5 Puntos de Historia (3 días).
