# Issue #15: feat(notifications): despachador de notificaciones y eventos en tiempo real con WebSocket / Socket.IO
**Etiqueta:** requirement

### Contexto
La tranquilidad de las familias y la coordinación depende de ser notificados al instante del abordaje, desembarque, aproximación o cualquier eventualidad que ocurra en el trayecto de los menores en la ruta escolar.

### Objetivo
Implementar el despachador de eventos y notificaciones en tiempo real (`NotificationDispatcherService`) integrando canales WebSocket / Socket.IO y la API REST del backend para la entrega inmediata de alertas operativas y cambios de estado.

### Alcance
- **Incluye:** Emisión de eventos en tiempo real por WebSocket / Socket.IO, persistencia transaccional del historial en la tabla `NOTIFICACION` (vinculada a `TIPO_NOTIFICACION`), cola de eventos asíncronos y despacho directo a salas familiares.
- **No incluye:** Proveedores de mensajería externos no contemplados en el stack oficial.

### Requisitos SRS v2.0
- RF-12 (Canal Oficial de Notificaciones), RF-20 (Motor de Notificaciones Automáticas por Evento y Estado), RNF-05 (Latencia de notificación < 2.5s).

### Tablas Involucradas
- `NOTIFICACION`, `TIPO_NOTIFICACION`, `ESTUDIANTE`, `ACUDIENTE`, `VIAJE`.

### Criterios de Aceptación
- **Dado** un cambio en la máquina de estados de custodia del menor (abordaje, desembarque, aproximación),
- **Cuando** el caso de uso procesa la transición en el backend,
- **Entonces** se emite el evento en tiempo real vía WebSocket / Socket.IO hacia la sala familiar correspondiente y se persiste en la tabla `NOTIFICACION` con latencia inferior a 2.5 segundos.

### Tareas Técnicas
- [ ] Implementación de `NotificationDispatcherService` conectado a la pasarela WebSocket / Socket.IO.
- [ ] Persistencia transaccional de alertas en `NOTIFICACION` y clasificación por `TIPO_NOTIFICACION`.
- [ ] Segmentación de eventos por sala de viaje y acudiente legitimado.
- [ ] Manejo de reintentos y confirmación de entrega en tiempo real.

### Principio SOLID Aplicado y Verificación
- **OCP (Open/Closed Principle):** Canales de emisión desacoplados bajo la interfaz `INotificationChannelPort`. La lógica central de notificación no se modifica al agregar nuevos tipos de eventos.
- **DIP (Dependency Inversion Principle):** Los casos de uso inyectan abstracciones de despacho, sin acoplarse a detalles de transporte de red.

### Criterios de Seguridad
- Validación estricta de suscripción por token JWT y pertenencia de la sesión familiar al menor correspondiente (privacidad diferencial).

### Verificación Automática
- Pruebas unitarias y de integración del despachador con mocks de WebSocket y aserciones de inserción en base de datos.

### Dependencias
- Depende de: #3 (Auth), #7 (Custody FSM), #9 (Entrega).
- Bloquea a: #20 (E2E Tests).

### Definición de Hecho (DoD)
- Notificaciones despachadas por WebSocket / Socket.IO en tiempo real con latencia < 2.5s y pruebas superadas al 100%.

### Riesgos y Mitigaciones
- **Riesgo:** Congestión de eventos concurrentes en horas pico de abordaje.
- **Mitigación:** Encolamiento en memoria asíncrono no bloqueante en NestJS.

### Estimación
- 5 Puntos de Historia (3 días).
