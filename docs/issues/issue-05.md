# Issue #5: feat(students): importación masiva de matrículas con validación transaccional y hash SHA-256
**Etiqueta:** requirement

### Contexto
Al inicio del año escolar, la Coordinación de Convivencia del Colegio San Benito del Otún debe cargar el censo estudiantil y la vinculación de tutores legales desde planillas tabulares CSV/Excel provistas por secretaría académica.

### Objetivo
Desarrollar el endpoint multipart y el servicio de procesamiento transaccional por lotes para importación de matrículas, con validación sintáctica de esquemas, cálculo de geolocalización domiciliaria preliminar, hashing SHA-256 del archivo para auditoría de integridad y reporte granular de inconsistencias.

### Alcance
- **Incluye:** Endpoint `POST /api/v1/students/import` (multipart/form-data con archivo CSV/XLSX); validación por fila; registro de trazabilidad en `importacion_matricula` con hash SHA-256; generación automática de `qr_token_hash` por estudiante; respuesta con matriz de filas procesadas vs. rechazadas.
- **No incluye:** Edición manual de registros defectuosos en el backend (se reportan en JSON para corrección por el colegio).

### Requisitos SRS v2.0
- RF-01 (Importación Masiva de Matrículas), RF-04 (Gestión de Matrícula y Cupos), RNF-08 (Auditoría de Carga).
- Almacenamiento del hash SHA-256 del archivo original para garantizar no-repudio.

### Tablas Involucradas
- `importacion_matricula`, `estudiante`, `acudiente`, `estudiante_acudiente`.

### Criterios de Aceptación
- **Dado** un archivo CSV con 200 filas de estudiantes (195 válidas y 5 con errores de formato de documento o emails corruptos),
- **Cuando** el coordinador ejecuta la importación mediante `POST /api/v1/students/import`,
- **Entonces** el sistema procesa transaccionalmente las 195 filas válidas, calcula y cifra sus datos (vía Issue #4), registra el hash SHA-256 en `importacion_matricula` y devuelve código HTTP 207 (Multi-Status) con el detalle exacto de las 5 líneas observadas.

### Tareas Técnicas
- [ ] Implementar `CsvStreamParser` mediante streams de Node.js para procesamiento de bajo consumo de memoria RAM.
- [ ] Diseñar DTO de validación por fila con `class-validator` (validación de parentesco, grado y formato de identificación).
- [ ] Implementar `StudentBatchService` con transacción TypeORM `QueryRunner` para inserción atómica por estudiante y tutores.
- [ ] Registrar evento de auditoría de carga con metadatos (nombre de archivo, tamaño, total registros, hash SHA-256).

### Principio SOLID Aplicado y Verificación
- **SRP (Single Responsibility):** `CsvStreamParser` parsea streams; `StudentRowValidator` valida integridad; `StudentBatchWriter` orquesta la persistencia.
- **ISP (Interface Segregation):** Interfaces de lectura de streams segregadas de la lógica de negocio de matrícula.

### Criterios de Seguridad
- OWASP ASVS V12.1 (Validación estricta de extensiones `.csv`/`.xlsx`, magic bytes, tamaño máximo de 10 MB y sanitización contra inyección de fórmulas CSV).

### Verificación Automática
- Pruebas unitarias de parsing con fixtures de archivos corruptos; pruebas de integración con rollback en caso de fallo crítico de base de datos.

### Dependencias
- **Depende de:** Issue #3 (Usuario autenticado con rol Coordinador) e Issue #4 (Cifrado de estudiantes y acudientes).
- **Bloquea a:** Issue #7 (Despacho de Viajes con alumnos matriculados).

### Definición de Hecho (DoD)
- Archivos de hasta 1,000 registros procesados en < 10 segundos, persistencia en base de datos cifrada y reporte de inconsistencias en JSON funcional.

### Riesgos y Mitigaciones
- **Riesgo:** Consumo excesivo de memoria en Node.js al subir archivos masivos.
- **Mitigación:** Lectura por chunks (streaming) sin cargar el archivo completo en memoria y límite de carga de 10 MB.

### Estimación
- 3 Puntos de Historia (2 días).
