# Supuestos, Propuestas y Decisiones de Arquitectura — Backend Camino Seguro

Este documento consolida las propuestas técnicas que no están explícitamente en el SRS v2.0 ni en el stack tecnológico, las decisiones operativas pendientes de confirmación y las discrepancias detectadas en la especificación.

---

## 1. Propuestas de Arquitectura y Seguridad [PROPUESTA]

Las siguientes decisiones representan estándares de ingeniería de software empresarial y seguridad de aplicaciones (OWASP ASVS L2), adoptadas para garantizar la mantenibilidad, escalabilidad e inmutabilidad del sistema:

1. **Arquitectura Hexagonal (Ports & Adapters) / Clean Architecture [PROPUESTA]:**
   - *Fundamento:* El stack oficial establece *"arquitectura modular + API REST + eventos en tiempo real"*. Se propone implementar Arquitectura Hexagonal en NestJS organizando cada módulo en capas: `domain/`, `application/`, `infrastructure/` e `interfaces/`. Esto garantiza desacoplamiento estricto de frameworks (DIP) y facilita pruebas unitarias con mocks de puertos.

2. **Identificadores UUIDv7 en Claves Primarias Expuestas [PROPUESTA]:**
   - *Fundamento:* Previene enumeración predecible de recursos (anti-IDOR según ASVS V4.1) y mantiene ordenamiento temporal nativo por milisegundos, mitigando la fragmentación de índices B-Tree en PostgreSQL frente a UUIDv4 tradicional.

3. **Hashing de Contraseñas con Argon2id [PROPUESTA]:**
   - *Fundamento:* Cumple con OWASP Password Storage Cheat Sheet y ASVS V2.1. Sustituye algoritmos legacy o bcrypt por Argon2id (mínimo 64 MB memoria, 3 iteraciones, 4 hilos paralelismo).

4. **Formato Unificado de Cifrado en Reposo [PROPUESTA]:**
   - *Fundamento:* Datos sensibles de menores (Ley 1581) y adultos se almacenan bajo el formato atómico `key_version:iv_b64:tag_b64:ciphertext_b64` utilizando **AES-256-GCM** y un dominio de validación regex en PostgreSQL.

5. **Blind Indexing HMAC-SHA256 Separado [PROPUESTA]:**
   - *Fundamento:* Búsqueda exacta de documentos de identidad sin descifrar masivamente tablas ni exponer datos en memoria, empleando una clave criptográfica independiente gestionada en Secrets Manager.

6. **Particionamiento Mensual de Telemetría GPS con Retención de 180 Días [PROPUESTA]:**
   - *Fundamento:* `registro_gps` recibe paquetes cada 5 segundos por móvil. Se implementan particiones de rango mensual (`registro_gps_YYYY_MM`) y un job de purga con desacoplamiento (`DETACH PARTITION CONCURRENTLY`) antes del `DROP TABLE` tras 180 días (periodo de auditoría legal escolar).

7. **Libro Mayor Forense Inmutable con SHA-256 y pg_advisory_xact_lock [PROPUESTA]:**
   - *Fundamento:* RNF-08 exige inmutabilidad forense. Se implementa encadenamiento criptográfico con serialización de bloqueos consultivos de transacción, garantizando secuencias contiguas sin bifurcaciones concurrentes tanto en `bitacora_auditoria` como en `historial_estado_custodia`.

8. **Aislamiento Multi-Tenant por Acudiente y Rol (NO por Colegio) [PROPUESTA / CLARIFICACIÓN]:**
   - *Fundamento:* El proyecto opera para **un único colegio** (Colegio San Benito del Otún). El requerimiento multi-tenant de RNF-02 corresponde al aislamiento estricto de datos entre familias (acudiente -> sus hijos exclusivamente) y perfiles de usuario, implementado mediante Row-Level Security (RLS) forzada.

9. **Escaneo de Malware y Antivirus en Carga de Expedientes [PROPUESTA]:**
   - *Fundamento:* Inspección de magic bytes y verificación de firmas de archivos adjuntos (documentos y consentimientos) previa al cifrado AES y almacenamiento seguro.

10. **Cobertura Mínima de Testing del 80% en Capa de Dominio [PROPUESTA]:**
    - *Fundamento:* Puerta de calidad en CI/CD que bloquea el merge a la rama principal si los casos de uso y entidades del core carecen de cobertura verificada.

---

## 2. Decisiones de Negocio Pendientes de Definir con el Colegio [PENDIENTE DE DEFINIR]

1. **Legitimación Automática del Acudiente como Receptor en Paradero:**
   - *Situación:* El SRS RF-05 y RF-06 detallan la lista de "Adultos Autorizados". ¿El acudiente titular que ejerce la patria potestad requiere estar registrado en `estudiante_autorizado` o su vínculo en `estudiante_acudiente` lo legitima automáticamente para recibir al menor?
   - *Implementación actual:* El modelo relacional soporta ambos flujos; en `entrega` se valida si el receptor es `ACUDIENTE` (en `estudiante_acudiente`) o `AUTORIZADO` (en `estudiante_autorizado`).

2. **Estado Inicial del Alumno en la Jornada de la Tarde:**
   - *Situación:* En la mañana el estudiante inicia en `EN_CASA_ESPERA`. En el recorrido de retorno de la tarde, el alumno ya está físicamente en el colegio.
   - *Implementación actual:* En el manifiesto de la tarde el estudiante inicia en `EN_CUSTODIA_INSTITUCIONAL` y transiciona a `A_BORDO_VEHICULO` al abordar en el patio escolar.

3. **Ventana de Espera Máxima en Puntos Ciegos antes de Declarar Anomalía:**
   - *Situación:* En RF-14 se menciona que el mapa en vivo en La Virginia se pausa aproximadamente 10 minutos y genera alerta anómala a los 25 minutos. ¿Este umbral de 25 minutos es uniforme para cualquier polígono de sombra celular o varía por longitud de tramo?
   - *Implementación actual:* Parametrizable en la tabla `zona_geografica` por polígono.

---

## 3. Inconsistencias Identificadas en el Documento SRS v2.0

1. **Latencia Máxima en Entrega de Notificaciones Push:**
   - *Discrepancia:* RF-12 ("Canal Oficial de Notificaciones Push") especifica despacho en **menos de 2.0 segundos**, mientras que RNF-05 ("Rendimiento y Latencia de Notificación") y RF-20 ("Motor de Notificaciones") establecen una latencia **inferior a 2.5 segundos** bajo redes 4G/5G.
   - *Resolución técnica de backend:* Se adopta el criterio más estricto (**< 2.0 segundos**) como meta de SLA en colas BullMQ/Redis.

2. **Franja de Indeterminación en Detección de Desvíos de Ruta (RF-18):**
   - *Discrepancia:* RF-18 establece que una separación de hasta **150 metros** se considera estado normal de viaje, y que al alejarse más de **300 metros** se dispara una alerta amarilla. El SRS no define qué comportamiento debe asumir el sistema en el rango intermedio (entre 151 y 299 metros).
   - *Resolución técnica de backend:* Se define internamente un estado preventivo `DESVIO_MENOR` sin alarma sonora, registrando evento en telemetría para monitoreo silencioso.
