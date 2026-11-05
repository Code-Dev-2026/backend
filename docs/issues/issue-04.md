# Issue #4: feat(students): criptovault de datos sensibles, expedientes y blind indexing HMAC
**Etiqueta:** requirement

### Contexto
La Ley Estatutaria 1581 de 2012 y OWASP ASVS L2 exigen máxima protección para los datos personales de menores de edad y adultos autorizados. Los números de identificación, nombres y teléfonos deben residir cifrados en reposo, garantizando a la vez búsquedas indexadas exactas sin descifrado masivo de tablas.

### Objetivo
Implementar el módulo `CryptoVaultService` para cifrado y descifrado de campos sensibles mediante AES-256-GCM (formato canónico `v1:iv:tag:ciphertext`) y generación de índices ciegos deterministas (HMAC-SHA256) con claves maestras gestionadas por variables de entorno seguras.

### Alcance
- **Incluye:** Cifrado de documentos, nombres y teléfonos en entidades `estudiante`, `acudiente`, `adulto_autorizado`; indexado ciego en columnas `documento_blind_index`; bóveda de biometría facial y consentimientos en `expediente_cifrado`; regla de minimización de datos del menor (prohibido almacenar fotos de estudiantes).
- **No incluye:** Almacenamiento de datos biométricos en texto plano ni exposición de llaves criptográficas en respuestas de API.

### Requisitos SRS v2.0
- RF-01 (Registro de Alumnos), RF-05 (Adultos Autorizados), RNF-01 (Cifrado Ley 1581), RNF-09 (Bóveda Cifrada de Expedientes).
- Cumplimiento del dominio PostgreSQL `formato_cifrado_aes` (Migración V001/V003).

### Tablas Involucradas
- `estudiante`, `acudiente`, `adulto_autorizado`, `estudiante_acudiente`, `expediente_cifrado`.

### Criterios de Aceptación
- **Dado** el registro de un estudiante o adulto autorizado con número de documento `1088123456`,
- **Cuando** se persiste en la base de datos,
- **Entonces** la columna `documento_cifrado` cumple estrictamente con el regex `^v[0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$` y `documento_blind_index` almacena un hash determinista de 64 caracteres hex.
- **Dado** un endpoint de consulta por número de documento,
- **Cuando** se ejecuta la consulta `WHERE documento_blind_index = HMAC(input, key)`,
- **Entonces** el registro se localiza mediante índice B-Tree sin descifrar filas innecesarias ni exponer el documento en texto plano.

### Tareas Técnicas
- [ ] Implementar `AesEncryptionService` con algoritmo `aes-256-gcm` y encapsulación en formato `version:iv:tag:ciphertext`.
- [ ] Implementar `BlindIndexService` con HMAC-SHA256 normalizado (mayúsculas y sin espacios).
- [ ] Crear repositorios TypeORM con transformadores/subscriptores de entidad para cifrado/descifrado transparente.
- [ ] Implementar servicio de almacenamiento seguro de biometría de adultos en `expediente_cifrado` con validación de magic bytes.

### Principio SOLID Aplicado y Verificación
- **OCP (Open/Closed):** Nuevos algoritmos de cifrado o versiones de llaves (`v2`, `v3`) se integran implementando la interfaz `ICryptoVaultService` sin modificar las entidades de dominio ni la base de datos.
- **SRP (Single Responsibility):** `AesEncryptionService` cifra/descifra; `BlindIndexService` indexa; los repositorios persisten.

### Criterios de Seguridad
- OWASP ASVS V6.2 (Criptografía moderna autenticada AES-GCM), V6.4 (Gestión de claves independientes).

### Verificación Automática
- Pruebas unitarias de cifrado reversible con autenticación de integridad (GCM auth tag) y pruebas de búsqueda exacta con Jest.

### Dependencias
- **Depende de:** Issue #1 (Scaffold NestJS) e Issue #2 (Migración V003 en PostgreSQL).
- **Bloquea a:** Issues #5, #7, #8, #9, #10, #11 y #18.

### Definición de Hecho (DoD)
- Ningún dato personal legible en consultas SQL directas; validación del regex PostgreSQL aprobada al 100% en tests.

### Riesgos y Mitigaciones
- **Riesgo:** Exposición de memoria en buffers temporales o fuga de clave HMAC.
- **Mitigación:** Aislamiento de claves maestras en Secret Managers y destrucción de buffers sensibles tras el cifrado.

### Estimación
- 5 Puntos de Historia (3 días).
