# Política de Seguridad - Proyecto Camino Seguro

## 1. Compromiso con la Seguridad y Protección de Menores

El sistema **Camino Seguro** custodia datos de menores de edad, información biométrica y de geolocalización en tiempo real. Por consiguiente, la seguridad, la confidencialidad y la privacidad son requerimientos funcionales y éticos de primer orden, alineados estrictamente con:
- La **Ley Estatutaria 1581 de 2012** (Protección de Datos Personales en Colombia) y el tratamiento reforzado de datos sensibles de niños, niñas y adolescentes.
- El estándar internacional **OWASP ASVS (Application Security Verification Standard) Nivel 2**.
- Buenas prácticas de gobernanza criptográfica (AES-256-GCM, HMAC Blind Index, Argon2id, inmutabilidad WORM).

## 2. Reporte Responsable de Vulnerabilidades

Si descubres una vulnerabilidad de seguridad en el backend o en la infraestructura de Camino Seguro, te agradecemos reportarla de manera responsable y coordinada.

- **Canal de reporte:** Envía los detalles técnicos a `seguridad@caminoseguro.edu.co` (o crea un *Security Advisory* privado en este repositorio).
- **Cifrado de la comunicación:** Puedes solicitar nuestra clave pública PGP institucional antes de remitir pruebas de concepto sensibles.
- **Tiempos de respuesta (SLA):**
  - Acuse de recibo inicial: máximo **24 horas hábiles**.
  - Evaluación y triaje de severidad (CVSS v3.1): máximo **72 horas**.
  - Mitigación o parche preliminar: según la criticidad (crítica: < 48 h; alta: < 7 días).

## 3. Guías para Investigadores (Safe Harbor)

Para garantizar un proceso de divulgación coordinado y ético:
- **No accedas, modifiques ni divulgues datos reales de menores, acudientes o rutas.**
- Emplea exclusivamente entornos de prueba o cuentas ficticias generadas en tu entorno local.
- No realices ataques de denegación de servicio (DoS/DDoS) contra la infraestructura de producción.
- Permítenos un plazo razonable para remediar el hallazgo antes de cualquier publicación externa.

## 4. Medidas de Seguridad Implementadas en el Backend

1. **Defensa en Profundidad en Base de Datos:**
   - Separación estricta de privilegios (`app_owner`, `app_user`, `app_user_operations`, `app_user_billing`).
   - Row-Level Security (RLS) activo para aislar estrictamente el acceso de cada acudiente a sus propios hijos y telemetría en vivo condicionada.
   - Esquema financiero `billing` completamente aislado e inaccesible para roles operativos.
2. **Criptografía Robusta en Reposo:**
   - Formato estándar `key_version:iv:tag:ciphertext` con llaves AES-256-GCM segregadas del blind index.
   - Documentos de identidad y números de teléfono cifrados. Búsqueda determinista mediante HMAC-SHA256 blind indexing.
   - Datos biométricos y expedientes de adultos autorizados almacenados con consentimiento expreso; datos del menor minimizados al extremo.
3. **Inmutabilidad y Auditoría Forense:**
   - Bitácora forense de auditoría encadenada con hashes SHA-256 secuenciales mediante candado consultivo de transacción (`pg_advisory_xact_lock`).
   - Triggers WORM (Write Once, Read Many) que bloquean de forma irrevocable sentencias `UPDATE`, `DELETE` o `TRUNCATE`.
