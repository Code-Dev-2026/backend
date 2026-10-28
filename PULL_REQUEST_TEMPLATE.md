## Descripción del Cambio
<!-- Resume de manera concisa el propósito del PR, citando los módulos o migraciones afectadas. -->

## Issue(s) Vinculado(s)
<!-- Relaciona el issue correspondiente, ej. Closes #24 -->
Closes #

## Trazabilidad con Requisitos SRS v2.0
<!-- Lista los requisitos funcionales o no funcionales cubiertos (ej. RF-06, RNF-01). Si es una propuesta técnica, márcala como [PROPUESTA]. -->
- [ ] RF- / RNF- / RN- / HU-

## Checklist de Calidad y Principios SOLID
- [ ] **SRP:** Cada clase o servicio modificado tiene una única razón de cambio.
- [ ] **OCP:** Se utilizaron interfaces o eventos para extender comportamiento sin modificar código cerrado.
- [ ] **LSP:** Los adaptadores implementan estrictamente sus puertos sin alterar pre/post-condiciones.
- [ ] **ISP:** Las interfaces son atómicas y orientadas al cliente (sin métodos innecesarios).
- [ ] **DIP:** La capa de dominio e invariantes de negocio no dependen de librerías externas o frameworks.

## Checklist de Seguridad (OWASP ASVS L2)
- [ ] No se exponen credenciales, llaves maestras o secretos en el código.
- [ ] Los campos sensibles utilizan formato `key_version:iv:tag:ciphertext` o blind index HMAC.
- [ ] Las consultas a base de datos utilizan parámetros enlazados (prevención de SQLi).
- [ ] Se respetan las políticas de Row-Level Security (RLS) y aislamiento acudiente-estudiante.
- [ ] Se preserva la inmutabilidad de la bitácora de auditoría forense y custodia.

## Verificación y Pruebas
- [ ] Pruebas unitarias añadidas o actualizadas.
- [ ] Pruebas de integración / DDL validadas contra PostgreSQL 16 + PostGIS.
- [ ] Pruebas manuales documentadas con capturas o logs anexos.
