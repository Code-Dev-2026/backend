# Issue #16: feat(offline): sincronización offline idempotente para dispositivos móviles de monitores
**Etiqueta:** requirement

### Contexto
En diversas zonas rurales o montañosas de Risaralda y Pereira (ej. Vía La Florida, Canceles) la cobertura celular se pierde temporalmente. La aplicación móvil de la monitora almacena los escaneos en SQLite local y debe sincronizarlos al recuperar señal sin generar registros dobles.

### Objetivo
Implementar el endpoint y procesador transaccional de sincronización offline idempotente (`/sync/offline`), procesando lotes de operaciones con validación de clave de dispositivo y deduplicación garantizada en `sync_operation`.

### Alcance
- **Incluye:** Endpoint `/sync/offline` (POST por lote); procesamiento atómico en orden cronológico (`fecha_cliente`); resolución de duplicados mediante `UNIQUE(id_dispositivo, idempotency_key)`; reporte de confirmación por operación.
- **No incluye:** Resolución de conflictos de edición simultánea multi-usuario (el viaje solo es operado por la monitora asignada).

### Requisitos SRS v2.0
- RF-06 (Custodia Resiliente), RF-08 (Asistencia sin Conectividad), RNF-04 (Tolerancia a Fallas en Puntos Ciegos de Cobertura), RNF-08 (Consistencia de Datos).
- [PROPUESTA] Re-ordenamiento de eventos por marca de tiempo local de cliente antes de aplicar transiciones en la base de datos.

### Tablas Involucradas
- `sync_operation`, `registro_de_asistencia`, `entrega`, `historial_estado_custodia`, `viaje_estudiante`.

### Criterios de Aceptación
- **Dado** un dispositivo de monitora que envía 5 registros de asistencia tomados en zona sin señal,
- **Cuando** el terminal recupera conectividad e invoca `/sync/offline` retransmitiendo el lote dos veces por corte de red,
- **Entonces** el servidor procesa el primer lote, detecta la duplicidad en el segundo mediante `idempotency_key`, y devuelve éxito en ambas ocasiones sin duplicar inserciones.

### Tareas Técnicas
- [ ] Endpoint `/sync/offline` con esquema de validación para arrays de operaciones atómicas.
- [ ] Servicio `OfflineSyncProcessor` con despacho cronológico a casos de uso de abordaje y descenso.
- [ ] Registro de trazabilidad y resultado en `sync_operation`.
- [ ] Manejo de transacciones seguras con compensación ante errores puntuales.

### Principio SOLID Aplicado y Verificación
- **SRP:** `OfflineSyncProcessor` se limita a deserializar y coordinar la idempotencia; delega la ejecución de reglas de negocio a `AbordajeUseCase` y `DescensoUseCase`.

### Criterios de Seguridad
- OWASP ASVS V11.1 (Prevención de ataques de repetición e inyección de eventos desincronizados).

### Verificación Automática
- Pruebas de integración enviando múltiples veces el mismo payload y validando el estado final único de las tablas.

### Dependencias
- **Depende de:** Issue #7 (FSM Custodia), Issue #8 (Abordaje QR), Issue #9 (Entrega).
- **Bloquea a:** Issue #20 (E2E Tests).

### Definición de Hecho (DoD)
- Deduplicación al 100% en pruebas automatizadas y soporte comprobado de ráfagas diferidas de asistencia.

### Riesgos y Mitigaciones
- **Riesgo:** Reloj local del móvil desincronizado enviando fechas futuras o pasadas.
- **Mitigación:** Rechazar eventos con desfase temporal mayor a 24 horas respecto al reloj del servidor y auditar `fecha_servidor`.

### Estimación
- 5 Puntos de Historia (3 días).
