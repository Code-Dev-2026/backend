## Descripción del Cambio
<!-- Resume de manera concisa el propósito del Pull Request y los componentes modificados. -->

## Issue(s) Vinculada(s)
<!-- Relaciona la Issue correspondiente, ej. Closes #3 o Resolves #6 -->
Closes #

## Checklist de Calidad y Principios SOLID
- [ ] **SRP:** Cada clase o servicio modificado tiene una única razón de cambio.
- [ ] **OCP:** Se utilizaron interfaces o eventos para extender comportamiento sin modificar código cerrado.
- [ ] **LSP:** Los adaptadores implementan estrictamente sus contratos de interfaz.
- [ ] **ISP:** Las interfaces son atómicas y orientadas al cliente (sin métodos innecesarios).
- [ ] **DIP:** La capa de dominio e invariantes de negocio no dependen de librerías externas o frameworks.

## Checklist de Seguridad y Calidad
- [ ] No se exponen credenciales, llaves maestras o secretos en el código ni en el diff.
- [ ] Las consultas a base de datos utilizan parámetros enlazados (prevención de SQLi).
- [ ] El código compila sin errores (`npm run build`).
- [ ] Todas las pruebas unitarias o de integración pasan en verde (`npm test`).
- [ ] El linter no arroja advertencias ni errores (`npm run lint`).
