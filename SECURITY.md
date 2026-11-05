# Política de Seguridad

## 1. Compromiso con la Seguridad y Privacidad

La seguridad, la confidencialidad y la privacidad son requerimientos fundamentales de primer orden en este backend, alineados estrictamente con:
- La **Ley Estatutaria 1581 de 2012** (Protección de Datos Personales) y el tratamiento reforzado de datos sensibles.
- Estándares internacionales **OWASP ASVS (Application Security Verification Standard)**.
- Principios de desarrollo seguro (defensa en profundidad, privilegios mínimos y criptografía en reposo).

---

## 2. Reporte Responsable de Vulnerabilidades

Si descubres una vulnerabilidad de seguridad en el backend o en la infraestructura del proyecto, te agradecemos reportarla de manera responsable y coordinada.

- **Canal de reporte:** Crea un *Security Advisory* privado en este repositorio de GitHub.
- **Tiempos de respuesta (SLA):**
  - Acuse de recibo inicial: máximo **24 horas hábiles**.
  - Evaluación y triaje de severidad (CVSS v3.1): máximo **72 horas**.
  - Mitigación o parche preliminar: según la criticidad de la vulnerabilidad.

---

## 3. Guías para Desarrolladores e Investigadores (Safe Harbor)

Para garantizar un proceso de desarrollo y divulgación ético:
- Nunca comitear credenciales, llaves privadas ni secretos al repositorio (utilizar `.env` y variables de entorno).
- Emplear exclusivamente entornos de desarrollo locales y datos de prueba ficticios.
- No realizar pruebas destructivas ni denegación de servicio.
- Permitir un plazo razonable para remediar cualquier hallazgo antes de su publicación externa.
