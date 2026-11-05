# Issue #17: feat(audit): bitácora forense de auditoría encadenada con SHA-256 e inmutabilidad estricta
**Etiqueta:** requirement

### Contexto
En caso de incidentes legales o controversias de custodia de menores, el sistema debe proveer evidencia informática inalterable que resista escrutinio pericial judicial.

### Objetivo
Implementar el motor de auditoría forense con encadenamiento criptográfico SHA-256 secuencial en `bitacora_auditoria`, protegido por candado consultivo de transacción (`pg_advisory_xact_lock`), inmutabilidad estricta (WORM) y servicio automatizado de verificación de integridad de la cadena.

### Alcance
- **Incluye:** Trigger de encadenamiento con secuencia incremental ordenada; payload determinista formateado con `|` y timestamps ISO UTC con microsegundos; trigger que arroja excepción ante cualquier `UPDATE`, `DELETE` o `TRUNCATE`; función de chequeo `fn_verificar_integridad_bitacora`; exportador de reportes probatorios.
- **No incluye:** Almacenamiento en redes Blockchain públicas (se utiliza encadenamiento criptográfico relacional WORM).

### Requisitos SRS v2.0
- RF-16 (Bitácora de Auditoría Forense), RF-17 (Reportes Probatorios e Informes Legales), RNF-01 (Inmutabilidad y No-Repudio), RNF-03 (Trazabilidad Forense).
- [PROPUESTA] Candado consultivo de transacción con clave numérica fija para serializar altas concurrentes sin rupturas de orden.

### Tablas Involucradas
- `bitacora_auditoria`, `historial_estado_custodia`, `incidente`.

### Criterios de Aceptación
- **Dado** un administrador malicioso con acceso SQL directo a la base de datos,
- **Cuando** intenta ejecutar `UPDATE bitacora_auditoria SET datos_nuevos = ...` o `TRUNCATE`,
- **Entonces** el trigger intercepta el comando y cancela la transacción arrojando una excepción de seguridad ASVS L2.
- **Dado** el registro de 500 operaciones en el sistema,
- **Cuando** se ejecuta `fn_verificar_integridad_bitacora(500)`,
- **Entonces** la función retorna `cadena_integra = true` sin ningún salto ni alteración de hash.

### Tareas Técnicas
- [ ] Interceptor global NestJS para inyectar contexto de usuario e IP en la sesión de base de datos.
- [ ] Verificador programado (Cron Job diario) de la integridad de la cadena de auditoría.
- [ ] Endpoint `/admin/auditoria/verificar-integridad` para generar constancias periciales.
- [ ] Generador de reportes probatorios certificados en PDF con firma digital del resumen criptográfico.

### Principio SOLID Aplicado y Verificación
- **SRP:** `AuditChainVerifier` se dedica exclusivamente a recalcular y contrastar los eslabones criptográficos; `AuditReportGenerator` formatea y consolida la evidencia.

### Criterios de Seguridad
- OWASP ASVS V1.14 (Registros de auditoría a prueba de manipulación), V7.1 (Seguridad en el registro de bitácoras).

### Verificación Automática
- Pruebas SQL de inmutabilidad (intentos de update/delete deben fallar) y prueba de detección de corrupción de hash.

### Dependencias
- **Depende de:** Issue #2 (Migración V008 auditoria_forense y triggers WORM), Issue #7 (Eventos de custodia).
- **Bloquea a:** Issue #20 (E2E Tests).

### Definición de Hecho (DoD)
- Triggers WORM probados y verificador criptográfico retornando 100% de éxito en la suite de pruebas.

### Riesgos y Mitigaciones
- **Riesgo:** Contención de transacciones en inserciones muy concurrentes debido al candado consultivo.
- **Mitigación:** Candado de ámbito de transacción (`pg_advisory_xact_lock`) con liberación automática inmediata y transacciones ultracortas.

### Estimación
- 5 Puntos de Historia (3 días).
