# Issue #1: feat(epic): orquestación general y arquitectura del backend de misión crítica - Camino Seguro
**Etiqueta:** requirement

### Contexto
El backend del proyecto "Camino Seguro" es el núcleo neurálgico responsable de gobernar la cadena de custodia física y digital de menores en el transporte escolar del Colegio San Benito del Otún (Pereira, Risaralda). Administra telemetría IoT vehicular, transacciones atómicas de abordaje/desembarque mediante QR, gobernanza de seguridad ASVS L2 y despacho en tiempo real hacia familias y directivas.

### Objetivo
Orquestar y coordinar la implementación integral de los módulos de base de datos, APIs de dominio, telemetría en streaming, auditoría forense inmutable y esquema de facturación segregado bajo principios SOLID y arquitectura hexagonal.

### Alcance
- **Incluye:** Consolidación de los 5 sprints (Sprint 0 al 4), diseño y acoplamiento de contratos de dominio en NestJS, gobernanza de seguridad ASVS L2 y cumplimiento estricto del SRS v2.0.
- **No incluye:** Interfaces gráficas frontend o aplicaciones móviles nativas.

### Requisitos SRS v2.0
- RF-01 al RF-18, RN-01 al RN-05, RNF-01 al RNF-08.
- ADR-001 Arquitectura Hexagonal y ADR-002 Inmutabilidad Criptográfica WORM.

### Módulos / Tablas Involucradas
- Totalidad de los esquemas `public` (39 tablas) y `billing` (3 tablas).

### Criterios de Aceptación
- **Dado** el despliegue del sistema completo en entorno local de pruebas,
- **Cuando** se ejecutan las transacciones concurrentes de abordaje, telemetría y entrega,
- **Entonces** se preserva el 100% de la cadena de custodia con latencia de notificación < 2.5s y cero fallos de inmutabilidad.

### Tareas Técnicas
- [x] Supervisión y cierre del Sprint 0 (Fundaciones e Infraestructura).
- [x] Supervisión y cierre del Sprint 1 (Identidad, Expedientes y Matrícula).
- [x] Supervisión y cierre del Sprint 2 (Operación de Rutas, Asistencia y Custodia).
- [x] Supervisión y cierre del Sprint 3 (Telemetría IoT, Desvíos y WebSocket).
- [x] Supervisión y cierre del Sprint 4 (Auditoría Forense, Billing y RLS).

### Principio SOLID Aplicado y Verificación
- **DIP (Dependency Inversion Principle):** El núcleo de dominio no acopla detalles de infraestructura; los adaptadores externos (PostgreSQL, MQTT, Socket.IO) dependen de abstracciones definidas mediante puertos en NestJS.

### Criterios de Seguridad
- OWASP ASVS L2 completo, cifrado de reposo AES-256-GCM, blind index HMAC, aislamiento multi-tenant familiar y perfiles de base de datos de mínimos privilegios.

### Verificación Técnica
- Compilación del proyecto (`npm run build`) y ejecución de pruebas unitarias de dominio (`npm test`) finalizando con código de salida 0.

### Dependencias
- Ninguna (Issue raíz de orquestación técnica).
- Bloquea a: Issues #2 a #20.

### Definición de Hecho (DoD)
- Todos los módulos compilados, contratos de interfaces desacopladas implementados y cobertura local de pruebas unitarias > 85%.

### Estimación
- 21 Puntos de Historia (Coordinación transversal Sprints 0-4).
