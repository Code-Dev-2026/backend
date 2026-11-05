# Issue #9: feat(custody): validación de receptores de entrega, desembarque seguro y retorno a sede
**Etiqueta:** requirement

### Contexto
Al llegar al destino (colegio o domicilio), el menor debe ser entregado única y exclusivamente a su acudiente titular o a un adulto previamente autorizado (máximo 3 por estudiante). Si no hay receptor acreditado, el niño jamás debe ser dejado a la deriva.

### Objetivo
Implementar el flujo transaccional de desembarque (`fn_registrar_descenso_atomico`), control de cupo liberado, verificación de receptores autorizados activos no vencidos y ejecución del protocolo de contingencia de retorno seguro a la sede escolar.

### Alcance
- **Incluye:** Endpoint `/asistencia/descenso`; validación de tipo de receptor (`ACUDIENTE`, `ADULTO_AUTORIZADO`, `SEDE_EDUCATIVA`); verificación del límite de 3 autorizados; manejo de `DESEMBARQUE_FALLIDO_RETORNO` manteniendo al estudiante a bordo hasta la sede escolar.
- **No incluye:** Modificación de autorizados durante el viaje en curso (debe gestionarse previamente).

### Requisitos SRS v2.0
- RF-09 (Registro de Desembarque y Entrega Segura), RF-11 (Protocolo de Estudiante No Recibido), RN-04 (Máximo 3 Adultos Autorizados).
- [PROPUESTA] En desembarque fallido, no decrementar `total_a_bordo` hasta que se certifique la recepción formal en rectoría/coordinación.

### Tablas Involucradas
- `viaje`, `entrega`, `registro_de_asistencia`, `estudiante_autorizado`, `incidente`, `viaje_estudiante`.

### Criterios de Aceptación
- **Dado** un estudiante que desciende en su domicilio pero ningún adulto autorizado comparece,
- **Cuando** la monitora reporta la no-entrega,
- **Entonces** el menor pasa a estado `RETORNO_SEDE_POR_FALLA_ENTREGA`, continúa contabilizado a bordo del vehículo, se genera un incidente crítico de custodia y se alerta de inmediato a los acudientes y a la coordinación.

### Tareas Técnicas
- [ ] Endpoint `/asistencia/descenso` con parámetros de receptor y método de validación.
- [ ] Lógica de validación de identidad del receptor contra blind index y autorizaciones vigentes.
- [ ] Endpoint `/asistencia/custodia/finalizar-sede` para cerrar la custodia formal en el colegio.
- [ ] Encolamiento de notificaciones de entrega exitosa o alerta de no-recepción.

### Principio SOLID Aplicado y Verificación
- **SRP:** `DeliveryValidationService` se encarga exclusivamente de verificar la potestad del receptor; `DisembarkUseCase` ejecuta el cambio de estado de custodia.

### Criterios de Seguridad
- OWASP ASVS V4.1 (Control de acceso y autorización estricta del receptor con trazabilidad no repudiable).

### Verificación Automática
- Pruebas de integración simulando entregas con autorizados vigentes, vencidos, no existentes y casos de retorno a sede.

### Dependencias
- **Depende de:** Issue #4 (Personas autorizadas), Issue #7 (FSM Custodia), Issue #8 (Abordaje QR).
- **Bloquea a:** Issues #10, #15, #16.

### Definición de Hecho (DoD)
- Flujo completo de entrega probado y verificado; protocolo de retorno a sede sin decremento erróneo de cupos.

### Riesgos y Mitigaciones
- **Riesgo:** Confusión en la parada cuando un adulto recibe a varios estudiantes emparentados.
- **Mitigación:** Validación independiente por cada menor garantizando una fila de `entrega` por cada estudiante entregado.

### Estimación
- 5 Puntos de Historia (3 días).
