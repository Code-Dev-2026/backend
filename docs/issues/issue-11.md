# Issue #11: feat(passengers): gestión transaccional de pasajeros ocasionales y reasignación de cupos
**Etiqueta:** requirement

### Contexto
Eventualmente, acudientes solicitan que su hijo viaje en una ruta distinta por motivos académicos o familiares. Dicha solicitud solo puede autorizarse si otro estudiante reportó inasistencia previa y existe cupo nominal disponible.

### Objetivo
Construir el servicio de reservas de pasajeros ocasionales (`pasajero_ocasional`), validando la antelación mínima de 2 horas respecto a la hora de salida programada del viaje y la existencia de una vacante efectiva por inasistencia.

### Alcance
- **Incluye:** Solicitud por parte del acudiente; verificación de vacantes en el viaje; autorización por Coordinación; restricción temporal (antelación $\ge 2$ horas); actualización de la lista de pasajeros del viaje.
- **No incluye:** Sobrecupo bajo ninguna excepción.

### Requisitos SRS v2.0
- RF-05 (Gestión de Pasajeros Ocasionales), RN-03 (Cupo Condicionado a Inasistencia Previa y Antelación de 2 Horas).
- [PROPUESTA] Validación atómica de vacante en base de datos para evitar doble asignación de la misma vacante.

### Tablas Involucradas
- `pasajero_ocasional`, `viaje`, `vehiculo`, `asignacion_ruta`, `viaje_estudiante`.

### Criterios de Aceptación
- **Dado** un viaje programado para iniciar a las 06:30 AM que no tiene reportes de inasistencia,
- **Cuando** un acudiente solicita un cupo ocasional a las 05:00 AM,
- **Entonces** el sistema rechaza la solicitud tanto por falta de vacante como por incumplir la antelación mínima de 2 horas.

### Tareas Técnicas
- [ ] Endpoint `/pasajeros-ocasionales/solicitar` y `/pasajeros-ocasionales/aprobar`.
- [ ] Verificación de antelación horaria contra `hora_inicio_programada`.
- [ ] Validación de balance de vacantes (estudiantes asignados - inasistencias reportadas < capacidad).
- [ ] Inclusión automática en la lista de asistencia del viaje tras aprobación.

### Principio SOLID Aplicado y Verificación
- **SRP:** `PassengerCapacityEvaluator` se especializa en calcular vacantes netas; `OccasionalBookingService` gestiona el ciclo de vida de la reserva.

### Criterios de Seguridad
- OWASP ASVS V4.1 (Autorización acudiente-estudiante: el acudiente solo puede solicitar viajes para sus propios hijos).

### Verificación Automática
- Pruebas unitarias de cálculo de antelación temporal y concurrencia de reservas sobre una única vacante.

### Dependencias
- **Depende de:** Issue #6 (Rutas y capacidad), Issue #8 (Control de sobrecupo y abordaje).
- **Bloquea a:** Issue #20 (E2E Tests).

### Definición de Hecho (DoD)
- Regla de 2 horas y validación de inasistencia previa garantizadas en pruebas de integración.

### Riesgos y Mitigaciones
- **Riesgo:** Cancelación tardía de una inasistencia reportada previamente.
- **Mitigación:** La política del colegio estipula que una inasistencia confirmada no puede revertirse si el cupo fue legalmente asignado a un pasajero ocasional.

### Estimación
- 3 Puntos de Historia (2 días).
