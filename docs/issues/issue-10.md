# Issue #10: feat(custody): motor de protección preventiva contra alertas judiciales activas
**Etiqueta:** requirement

### Contexto
Existen medidas de protección dictadas por Comisarías de Familia o Juzgados que restringen el acercamiento o la entrega de menores a determinados progenitores o terceros. El sistema debe impedir automáticamente la entrega del niño al individuo sancionado.

### Objetivo
Desarrollar el motor de verificación judicial preventiva que, al momento del desembarque, compara el documento del receptor contra el blind index de alertas judiciales activas (`alerta_judicial`), bloqueando la entrega de forma categórica, notificando a Coordinación y activando el protocolo de seguridad.

### Alcance
- **Incluye:** Cruce determinista vía `documento_restringido_hash`; bloqueo estricto en el intento de entrega; no bloqueo en el abordaje (el niño debe subir a salvo al vehículo); registro de incidente judicial; notificación de máxima prioridad.
- **No incluye:** Conexión directa en línea con las bases de datos de la Fiscalía o Rama Judicial (se alimenta por Coordinación).

### Requisitos SRS v2.0
- RF-02 (Registro de Alertas y Medidas Cautelares), RF-09 (Validación Judicial de Entrega), RNF-01 (Seguridad Absoluta del Menor).
- [PROPUESTA] Datos de la orden judicial cifrados con AES-256-GCM y búsqueda determinista mediante HMAC.

### Tablas Involucradas
- `alerta_judicial`, `entrega`, `incidente`, `notificacion`.

### Criterios de Aceptación
- **Dado** un estudiante con medida judicial activa que prohíbe su entrega al progenitor con cédula `79123456`,
- **Cuando** dicho progenitor intenta recibir al menor en la parada y su documento es digitado o escaneado,
- **Entonces** el sistema bloquea inmediatamente la entrega retornando `ALERTA_JUDICIAL_BLOQUEANTE`, mantiene al niño en el bus, despacha SMS de emergencia a la madre y alerta a la Policía de Infancia y Adolescencia institucional.

### Tareas Técnicas
- [ ] Módulo de gestión y consulta segura de `alerta_judicial` por blind index.
- [ ] Validación integrada en `fn_registrar_descenso_atomico`.
- [ ] Despacho de notificación de emergencia tipo `ALERTA_JUDICIAL_ACTIVADA`.
- [ ] Generación automática de acta de incidente en `incidente`.

### Principio SOLID Aplicado y Verificación
- **OCP:** El motor judicial opera como un validador en la cadena de responsabilidad (`DeliveryInterceptor`) que puede incorporar nuevas reglas cautelares sin modificar el núcleo de desembarque.

### Criterios de Seguridad
- OWASP ASVS V1.14 y Principio de Defensa en Profundidad (la base de datos y la capa de aplicación rechazan la entrega).

### Verificación Automática
- Pruebas automatizadas simulando intentos de entrega a individuos restringidos verificando el rechazo instantáneo.

### Dependencias
- **Depende de:** Issue #4 (Expedientes y vínculos familiares), Issue #9 (Proceso de entrega a receptores).
- **Bloquea a:** Issue #20 (E2E Tests).

### Definición de Hecho (DoD)
- Imposibilidad matemática de autorizar la entrega ante coincidencia de blind index judicial en la suite de pruebas.

### Riesgos y Mitigaciones
- **Riesgo:** Falso positivo por homonimia.
- **Mitigación:** Blind index sobre documento único de identidad (cédula de ciudadanía o extranjería).

### Estimación
- 3 Puntos de Historia (2 días).
