# Guía de Contribución al Backend

Para mantener altos estándares de calidad arquitectónica, principios SOLID y buenas prácticas de ingeniería de software, todos los desarrolladores deben seguir estas directrices.

---

## 1. Flujo de Trabajo con Git (GitHub Flow)

- La rama `main` refleja el código probado, validado y estable.
- Cada funcionalidad o corrección se implementa a partir de las Issues oficiales documentadas en `docs/issues/` o en GitHub Issues.
- Las ramas de trabajo deben seguir la convención:
  - `feat/issue-XX-nombre-corto`
  - `fix/issue-XX-nombre-corto`
  - `docs/issue-XX-nombre-corto`
  - `test/issue-XX-nombre-corto`

---

## 2. Convención de Commits (Conventional Commits)

Cada commit debe ser atómico y seguir el estándar [Conventional Commits v1.0.0](https://www.conventionalcommits.org/):

```
<tipo>(<alcance>): <descripción concisa en modo imperativo>

[cuerpo opcional detallando el porqué del cambio y decisiones tomadas]

[pie opcional con referencias a issues, ej. Closes #3]
```

### Tipos Permitidos:
- `feat`: Nueva funcionalidad backend.
- `fix`: Corrección de un defecto o bug.
- `refactor`: Refactorización interna de código sin alterar comportamiento externo.
- `perf`: Mejoras de rendimiento.
- `test`: Creación o ajuste de pruebas unitarias o de integración.
- `docs`: Modificaciones en documentación.
- `chore`: Tareas de mantenimiento, dependencias o configuración.

---

## 3. Principios de Diseño Arquitectónico (SOLID & Clean Architecture)

1. **Single Responsibility Principle (SRP):** Cada caso de uso, servicio y controlador atiende una única responsabilidad de dominio.
2. **Open/Closed Principle (OCP):** Los componentes deben estar abiertos a la extensión pero cerrados a la modificación mediante polimorfismo e interfaces.
3. **Liskov Substitution Principle (LSP):** Las implementaciones concretas deben ser sustituibles por sus abstracciones de contrato.
4. **Interface Segregation Principle (ISP):** Interfaces pequeñas y específicas para cada consumidor.
5. **Dependency Inversion Principle (DIP):** El núcleo de dominio depende de abstracciones (puertos/interfaces) y no de detalles de infraestructura.

---

## 4. Requisitos de Calidad antes de Enviar un Pull Request

Antes de solicitar revisión de un Pull Request:
1. Compilación exitosa: `npm run build`.
2. Pruebas unitarias pasando al 100%: `npm test`.
3. Análisis de linter sin errores: `npm run lint`.
4. Validar que no existan credenciales ni variables sensibles en el diff (`git diff`).
5. Completar todos los puntos del checklist en `PULL_REQUEST_TEMPLATE.md`.
