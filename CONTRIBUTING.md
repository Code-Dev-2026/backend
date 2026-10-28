# Guía de Contribución al Backend - Camino Seguro

Bienvenido al repositorio central del backend de **Camino Seguro**. Para mantener los más altos estándares de calidad arquitectónica, principios SOLID y seguridad ASVS L2, todos los desarrolladores deben seguir estas directrices.

---

## 1. Flujo de Trabajo con Git (GitFlow Simplificado)

- La rama `main` refleja el código probado, validado y listo para despliegue.
- Todas las características, correcciones y refactorizaciones deben originarse desde `main` en ramas temáticas descriptivas:
  - `feat/nombre-feature`
  - `fix/nombre-bug`
  - `docs/documentacion`
  - `refactor/nombre-modulo`
  - `test/nombre-cobertura`

---

## 2. Convención de Commits (Conventional Commits)

Cada commit debe ser atómico y seguir el estándar [Conventional Commits v1.0.0](https://www.conventionalcommits.org/):

```
<tipo>(<alcance>): <descripción concisa en modo imperativo>

[cuerpo opcional detallando el porqué del cambio y decisiones tomadas]

[pie opcional con referencias a issues, ej. Closes #12]
```

### Tipos Permitidos:
- `feat`: Nueva funcionalidad backend.
- `fix`: Corrección de un defecto o bug.
- `refactor`: Refactorización interna de código sin alterar comportamiento externo.
- `perf`: Mejoras de rendimiento o latencia.
- `test`: Creación o ajuste de pruebas unitarias/integración.
- `docs`: Modificaciones en documentación o diagramas.
- `chore`: Tareas de mantenimiento, dependencias o configuración CI/CD.

---

## 3. Principios de Diseño Arquitectónico (SOLID & Hexagonal)

1. **Single Responsibility Principle (SRP):** Cada caso de uso, servicio y repositorio atiende una única responsabilidad de dominio.
2. **Open/Closed Principle (OCP):** Las reglas de negocio se extienden mediante polimorfismo y eventos, sin modificar los núcleos de custodia.
3. **Liskov Substitution Principle (LSP):** Todas las implementaciones de puertos de almacenamiento, mensajería y cifrado son sustituibles por sus contratos de interfaz.
4. **Interface Segregation Principle (ISP):** Interfaces pequeñas y específicas para cada consumidor (ej. `IAuthRepository`, `ITelemetryIngestPort`, `ICustodyEventPublisher`).
5. **Dependency Inversion Principle (DIP):** El núcleo de dominio no depende de TypeORM, Express, Socket.IO o MQTT; los adaptadores externos dependen de las abstracciones internas.

---

## 4. Requisitos de Calidad antes de Enviar un Pull Request

Antes de solicitar revisión de un Pull Request:
1. Asegurar que las migraciones DDL cumplen con `snake_case`, tipos PostGIS sin casts y formato de cifrado estándar.
2. Ejecutar la suite de pruebas locales o Dockerizadas: `npm test` / `psql -f db/tests/test_suite_camino_seguro.sql`.
3. Validar que no existen secretos ni variables de entorno sensibles en el diff (`git diff`).
4. Completar todos los puntos del checklist en `PULL_REQUEST_TEMPLATE.md`.
