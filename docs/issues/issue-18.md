# Issue #18: feat(billing): esquema desacoplado de facturación, cartera y pagos con inmunidad operativa
**Etiqueta:** requirement

### Contexto
El SRS y las normas colombianas de protección a la infancia prohíben categóricamente bajar a un menor del vehículo o negarle el transporte de regreso por mora económica de sus padres. Además, los roles operativos (conductores y monitoras) no deben tener acceso a la información financiera familiar.

### Objetivo
Construir el módulo administrativo de facturación, cartera y pagos dentro del esquema aislado `billing`, garantizando inmunidad operativa (el estado de mora en cartera jamás bloquea el abordaje ni el descenso del menor) y segregación estricta de roles.

### Alcance
- **Incluye:** Tablas `billing.cartera`, `billing.factura`, `billing.pago`; endpoints administrativos `/billing/*`; cálculo de estados (`AL_DIA`, `EN_MORA`, `SUSPENDIDO`); garantía en código de que ningún caso de uso de custodia consulta la cartera; revocación de permisos a `app_user_operations`.
- **No incluye:** Pasarela de recaudos en tiempo real con débito automático.

### Requisitos SRS v2.0
- RF-18 (Facturación y Cartera de Transporte), RN-01 (Inmunidad de Custodia frente a Estado de Mora Financiera), RNF-02 (Segregación de Información Financiera).
- [PROPUESTA] Esquema de base de datos `billing` completamente independiente de `public` y sin grants al rol operativo.

### Tablas Involucradas
- `billing.cartera`, `billing.factura`, `billing.pago`, `public.estudiante`, `public.acudiente`.

### Criterios de Aceptación
- **Dado** un estudiante cuyos acudientes presentan una mora de 60 días en `billing.cartera`,
- **Cuando** la monitora escanea al estudiante para el abordaje o desembarque,
- **Entonces** el sistema autoriza el servicio con total normalidad sin mostrar mensajes discriminatorios de cobro a la monitora ni al conductor.

### Tareas Técnicas
- [ ] Endpoints de gestión de cartera, emisión de factura mensual y registro de pagos.
- [ ] Implementación de `BillingService` bajo módulo independiente `BillingModule`.
- [ ] Auditoría de dependencias para certificar que `CustodyModule` no importa `BillingModule`.
- [ ] Verificación de permisos de base de datos (rol `app_user_operations` no puede leer `billing.*`).

### Principio SOLID Aplicado y Verificación
- **ISP e Inversión de Dependencias:** El módulo de custodia es totalmente ignorante de la existencia de la cartera. No existen dependencias cruzadas entre el subdominio logístico y el financiero.

### Criterios de Seguridad
- OWASP ASVS V4.1 (Control de acceso vertical: conductores y monitoras tienen denegación por defecto sobre el esquema `billing`).

### Verificación Automática
- Prueba unitaria de análisis de grafo de dependencias de NestJS que falla si se detecta acoplamiento entre `CustodyModule` y `BillingModule`.

### Dependencias
- **Depende de:** Issue #2 (Migración V009 esquema billing), Issue #3 (Auth), Issue #5 (Matrículas).
- **Bloquea a:** Issue #19 (RLS en cartera).

### Definición de Hecho (DoD)
- Esquema `billing` operativo, permisos restringidos y prueba de inmunidad de custodia aprobada.

### Riesgos y Mitigaciones
- **Riesgo:** Intento de requerir validación de solvencia económica antes de emitir listas de viaje.
- **Mitigación:** Regla de negocio inmutable codificada en las entidades de dominio y documentada en el ADR de inmunidad.

### Estimación
- 5 Puntos de Historia (3 días).
