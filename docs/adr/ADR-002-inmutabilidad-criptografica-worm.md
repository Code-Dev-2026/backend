# ADR-002: Inmutabilidad Criptográfica WORM y Bóveda de Datos Sensibles

- **Estado:** Aceptado
- **Fecha:** 2026-11-07
- **Autor:** Equipo de Arquitectura Backend — Camino Seguro
- **Contexto:** Issue #1 (Épica de Orquestación General y Arquitectura), RNF-01, RNF-08, Ley 1581 de 2012, OWASP ASVS L2

---

## 1. Contexto y Problema

El sistema gestiona datos biométricos, identidad y coordenadas físicas en tiempo real de menores de edad escolar. El marco legal colombiano (Ley Estatutaria 1581 de 2012 y Decreto 1377 de 2013) cataloga estos datos como **Datos Sensibles de Especial Protección**. Asimismo, la cadena de custodia física (quién recibe al menor, en qué parada, a qué hora, con qué consentimiento) exige valor probatorio forense legal que impida cualquier alteración o repudio retroactivo.

---

## 2. Decisión de Arquitectura

Se establece un modelo de seguridad basado en dos pilares criptográficos complementarios:

### A. Persistencia WORM (Write Once, Read Many) y Encadenamiento SHA-256

1. **Tablas de Custodia y Auditoría Inmutables:**
   - `bitacora_auditoria` e `historial_estado_custodia` se declaran estrictamente como registros de sólo inserción (*Append-Only*).
   - Bloqueo a nivel de motor SQL: triggers `BEFORE UPDATE OR DELETE` que arrojan excepciones de violación de inmutabilidad ante intentos de manipulación, incluso por roles administradores.

2. **Encadenamiento Criptográfico (Merkle / Chained Hashing):**
   - Cada registro incorpora un campo `hash_actual` y `hash_anterior`.
   - `hash_actual = SHA-256(id || hash_anterior || payload_canonico_json || salt || created_at)`.
   - La inserción concurrente se serializa mediante bloqueos consultivos de transacción PostgreSQL (`pg_advisory_xact_lock`), asegurando una cadena sin bifurcaciones.

### B. Criptovault de Datos Sensibles en Reposo (AES-256-GCM + Blind Index)

1. **Cifrado Atómico en Reposo:**
   - Todos los campos de identificación y nombres de menores y adultos autorizados se almacenan cifrados con **AES-256-GCM** (Galois/Counter Mode).
   - Formato unificado:
     ```
     key_version:iv_base64:tag_base64:ciphertext_base64
     ```
   - El vector de inicialización (`iv`, 96 bits) se genera de forma aleatoria criptográfica por cada registro para evitar criptoanálisis por repetición.
   - El `tag` de autenticación de 128 bits garantiza integridad y detección inmediata de manipulación de datos en reposo.
   - Soporte nativo para rotación de llaves maestras mediante `key_version` (ej. `v1`, `v2`).

2. **Blind Indexing Determinístico (HMAC-SHA256):**
   - Para permitir búsquedas exactas por documento de identidad (ej. cédula o tarjeta de identidad) sin tener que descifrar toda la base de datos ni indexar texto claro, se calcula un **Blind Index**:
     ```
     blind_index = HMAC-SHA256(key_hmac_blind, Normalizar(documento))
     ```
   - La clave `key_hmac_blind` es independiente de la clave de cifrado AES-256 y reside en variables de entorno seguras.
   - La normalización elimina espacios en blanco y estandariza mayúsculas/minúsculas.

---

## 3. Consecuencias y Beneficios

- **Cumplimiento Legal Total:** Pleno amparo legal ante requerimientos de Fiscalía, ICBF o directivas escolares con evidencia forense inmutable.
- **Protección contra Fuga de Datos:** Incluso ante un volcado (*dump*) no autorizado de la base de datos, la información sensible permanece cifrada e ininteligible.
- **Rendimiento Óptimo:** Búsquedas por `blind_index` sobre índices B-tree en PostgreSQL con latencia sub-milisegundo.
