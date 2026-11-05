# Issue #7: feat(custody): ciclo de custodia física, máquina de estados FSM y persistencia WORM
**Etiqueta:** requirement

### Contexto
El activo supremo del sistema es la custodia legal del menor. El estado físico de un estudiante no puede sufrir inconsistencias ni saltos temporales ilógicos durante el recorrido escolar.

### Objetivo
Implementar la máquina de estados finitos (FSM) que gobierna el ciclo de custodia (`viaje_estudiante` e `historial_estado_custodia`), garantizando transiciones unidireccionales válidas, reinicio diario automático y encadenamiento criptográfico SHA-256 en cada evento.

### Alcance
- **Incluye:** FSM estricta: `NO_INICIADO` $ightarrow$ `EN_ESPERA_ABORDAJE` $ightarrow$ `A_BORDO_VEHICULO` $ightarrow$ `EN_COLEGIO` (mañana) o `ENTREGADO_ACUDIENTE` (tarde), más el estado de contingencia `RETORNO_SEDE_POR_FALLA_ENTREGA`; inmutabilidad estricta WORM en base de datos.
- **No incluye:** Hardware biométrico externo.

### Requisitos SRS v2.0
- RF-06 (Control de Cadena de Custodia), RF-07 (Ciclo de Vida de Viajes), RN-01 (Transiciones Válidas de Custodia), RNF-01 (Integridad Forense).
- [PROPUESTA] Tabla de estados por viaje (`viaje_estudiante`) para permitir re-asignación en ruta matutina y vespertina sin conflicto.

### Tablas Involucradas
- `viaje`, `viaje_estudiante`, `historial_estado_custodia`.

### Criterios de Aceptación
- **Dado** un estudiante en estado `NO_INICIADO`,
- **Cuando** se intenta forzar directamente una transición a `ENTREGADO_ACUDIENTE`,
- **Entonces** la FSM rechaza la operación arrojando un error de violación de invariante de negocio sin alterar la base de datos.

### Tareas Técnicas
- [ ] Implementación de la FSM de Custodia en capa de dominio (`CustodyStateMachine`).
- [ ] Servicio de validación de transiciones permitidas según tipo de recorrido (Mañana / Tarde).
- [ ] Integración con la función almacenada de base de datos para inserción encadenada en `historial_estado_custodia`.
- [ ] Job de inicialización matutina de estados para los estudiantes con servicio contratado.

### Principio SOLID Aplicado y Verificación
- **LSP (Liskov Substitution Principle):** Las diferentes transiciones de estado implementan el contrato `ICustodyTransition`, pudiendo ser invocadas de forma homogénea por el orquestador de custodia.

### Criterios de Seguridad
- OWASP ASVS V1.14 (Integridad de transacciones de custodia auditadas criptográficamente).

### Verificación Automática
- Pruebas unitarias de cobertura exhaustiva de la matriz de transición de la FSM (100% de caminos y transiciones inválidas).

### Dependencias
- **Depende de:** Issue #2 (DDL Custodia), Issue #3 (Auth), Issue #4 (Estudiantes), Issue #6 (Rutas y Paradas).
- **Bloquea a:** Issues #8, #9, #15, #16, #17.

### Definición de Hecho (DoD)
- Matriz completa de transiciones probada y triggers de inmutabilidad validados en PostgreSQL.

### Riesgos y Mitigaciones
- **Riesgo:** Estudiantes sin desembarque registrado al finalizar el viaje.
- **Mitigación:** Bloqueo del cierre del viaje (`FINALIZADO`) si existen menores con estado `A_BORDO_VEHICULO`.

### Estimación
- 5 Puntos de Historia (3 días).
