# Issue #14: feat(realtime): pasarela WebSocket Socket.IO con salas segmentadas y aislamiento familiar
**Etiqueta:** requirement

### Contexto
Los padres de familia requieren observar la ubicación del transporte escolar en el mapa en vivo de su aplicación móvil, pero la privacidad exige que ningún acudiente pueda rastrear al vehículo cuando su hijo ya desembarcó o antes de que suba.

### Objetivo
Implementar la pasarela WebSocket sobre Socket.IO 4.x con autenticación mediante JWT, segmentación estricta de canales (`rooms`) por viaje y filtro de difusión que entrega el stream GPS al acudiente exclusivamente mientras el menor se encuentre `A_BORDO_VEHICULO`.

### Alcance
- **Incluye:** Socket.IO Gateway en NestJS; handshake autenticado vía JWT; suscripción dinámica a salas `trip:{id_viaje}`; evaluación en tiempo de difusión del estado de custodia del hijo del usuario; eventos de telemetría y cambios de estado.
- **No incluye:** Streaming de video en vivo.

### Requisitos SRS v2.0
- RF-10 (Seguimiento en Vivo para Acudientes), RNF-02 (Aislamiento de Información por Usuario), RNF-05 (Latencia en Vivo < 2.5s).
- [PROPUESTA] Desconexión o silenciado automático del canal GPS del viaje en el socket del acudiente tan pronto se registra el desembarque.

### Tablas Involucradas
- `usuario`, `acudiente`, `estudiante_acudiente`, `viaje`, `registro_de_asistencia`, `viaje_estudiante`.

### Criterios de Aceptación
- **Dado** un acudiente conectado a la sala del viaje `V-100` cuyo hijo desciende en la parada 3,
- **Cuando** se confirma el desembarque exitoso del menor,
- **Entonces** el servidor de WebSockets cesa inmediatamente la transmisión de eventos de coordenadas GPS hacia ese acudiente específico.

### Tareas Técnicas
- [ ] `TelemetryGateway` en NestJS con adaptador de autenticación JWT en el apretón de manos.
- [ ] Gestor de subscripciones a salas con validación de roles y parentesco familiar.
- [ ] Interceptor de eventos GPS para verificar la condición `A_BORDO_VEHICULO` antes de emitir a acudientes.
- [ ] Manejo de reconexiones automáticas y heartbeat para clientes móviles.

### Principio SOLID Aplicado y Verificación
- **SRP:** `TelemetryGateway` se encarga de la comunicación WebSockets; `StreamingAuthorizationFilter` determina qué clientes están autorizados para recibir cada frame telemático.

### Criterios de Seguridad
- OWASP ASVS V3.2 (Autenticación obligatoria de WebSockets y autorización por mensaje).

### Verificación Automática
- Pruebas E2E de WebSockets simulando clientes con hijos a bordo vs clientes con hijos ya desembarcados.

### Dependencias
- **Depende de:** Issue #3 (JWT en WebSockets), Issue #12 (Eventos telemáticos).
- **Bloquea a:** Issue #15 (Notificaciones).

### Definición de Hecho (DoD)
- Stream de coordenadas con latencia < 1 segundo y verificación de corte de transmisión post-descenso aprobada.

### Riesgos y Mitigaciones
- **Riesgo:** Saturación de CPU en la pasarela WebSocket por alto número de conexiones simultáneas.
- **Mitigación:** Throttle de emisión a máximo 1 actualización cada 2 segundos por cliente conectado.

### Estimación
- 5 Puntos de Historia (3 días).
