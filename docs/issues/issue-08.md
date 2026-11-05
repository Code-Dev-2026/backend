# Issue #8: feat(attendance): control atómico de abordaje QR y prevención concurrente de sobrecupo
**Etiqueta:** requirement

### Contexto
Durante el abordaje matutino o vespertino, la monitora escanea los códigos QR de los estudiantes de manera sucesiva y en ocasiones simultánea en rutas combinadas. La normativa prohíbe taxativamente transportar estudiantes de pie o exceder la capacidad homologada del automotor.

### Objetivo
Desarrollar el caso de uso y endpoint de registro de abordaje atómico (`fn_registrar_abordaje_atomico`), garantizando control anti-sobrecupo a nivel de fila (`UPDATE viaje SET total_a_bordo = total_a_bordo + 1 WHERE ... < capacidad`), rechazo de doble escaneo y registro de incidentes en tiempo real.

### Alcance
- **Incluye:** Endpoint `/asistencia/abordaje`; validación de QR dinámico o estático homologado; validación de viaje `EN_CURSO`; verificación de asignación del estudiante a la ruta; bloqueo con `FOR UPDATE`; emisión inmediata de evento WebSocket.
- **No incluye:** Impresión física de carnets QR.

### Requisitos SRS v2.0
- RF-08 (Registro de Asistencia y Abordaje), RN-02 (Prohibición Estricta de Sobrecupo), RN-05 (Rechazo de Doble Abordaje).
- [PROPUESTA] Mecanismo de respuesta JSON no fatal con código estructurado (`DENEGADO_SOBRECUPO`, `ABORDAJE_PREVIO_EXISTE`) e inserción automática de incidente.

### Tablas Involucradas
- `viaje`, `vehiculo`, `registro_de_asistencia`, `viaje_estudiante`, `incidente`.

### Criterios de Aceptación
- **Dado** un vehículo con capacidad máxima de 15 pasajeros y 15 estudiantes a bordo,
- **Cuando** la monitora escanea al estudiante número 16,
- **Entonces** la transacción no incrementa el contador, rechaza el abordaje con código `DENEGADO_SOBRECUPO`, registra un incidente de seguridad y emite una alerta a Coordinación.

### Tareas Técnicas
- [ ] Endpoint `/asistencia/abordaje` con validación DTO y contexto de monitora autenticada.
- [ ] Invocación transaccional de la función almacenada `fn_registrar_abordaje_atomico`.
- [ ] Emisión de evento en tiempo real `student:boarded` vía Socket.IO.
- [ ] Encolamiento de notificación push hacia el acudiente titular del menor.

### Principio SOLID Aplicado y Verificación
- **SRP:** `AttendanceService` coordina la operación de abordaje; `CapacityEnforcer` verifica las reglas de cupo físico; `IncidentLogger` captura excepciones operativas.

### Criterios de Seguridad
- OWASP ASVS V11.1 (Prevención de condiciones de carrera mediante serialización atómica en base de datos).

### Verificación Automática
- Prueba de estrés de concurrencia simulando 20 abordajes simultáneos sobre un vehículo de capacidad 5 (deben pasar exactamente 5 y rebotar 15).

### Dependencias
- **Depende de:** Issue #4 (Estudiantes/Criptovault), Issue #7 (Custodia FSM).
- **Bloquea a:** Issues #9, #11, #16.

### Definición de Hecho (DoD)
- Prueba concurrente de sobrecupo pasando con éxito y tiempos de respuesta de escaneo < 200 ms.

### Riesgos y Mitigaciones
- **Riesgo:** Escaneo duplicado por lentitud de red en el móvil de la monitora.
- **Mitigación:** Restricción `UNIQUE(id_viaje, id_estudiante, tipo_evento)` en `registro_de_asistencia` y bloqueo por clave idempotente.

### Estimación
- 5 Puntos de Historia (3 días).
