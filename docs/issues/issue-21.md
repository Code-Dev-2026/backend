# Issue #21: ci(workflow): pipeline de integración continua con linter, análisis SAST CodeQL y verificación de compilación
**Etiqueta:** automation

### Contexto
El backend requiere validación automatizada de estándares de código y análisis de vulnerabilidades en el repositorio.

### Relación
- Relacionada con #1.

### Objetivo
Configurar el pipeline de GitHub Actions que ejecute linter, análisis SAST CodeQL y verificación de compilación del backend.

### Alcance
- **Incluye:** Pipeline de GitHub Actions ejecutando linter, análisis SAST CodeQL y compilación del backend.
- **No incluye:** Reglas de negocio ni lógica de dominio del sistema de transporte escolar.

### Criterios de Aceptación
- **Dado** un cambio enviado al repositorio,
- **Cuando** se dispara el pipeline de GitHub Actions,
- **Entonces** ejecuta el linter, el análisis estático SAST CodeQL y la compilación, reportando si el estado final es satisfactorio o con fallos.

### Tareas Técnicas
- [ ] Configuración del workflow en `.github/workflows/`.
- [ ] Configuración de la ejecución del linter.
- [ ] Configuración del análisis SAST con CodeQL.
- [ ] Configuración del paso de compilación del backend.

### Verificación Automatizada
- Ejecución del pipeline de GitHub Actions finalizando con código de salida 0 en los checks del commit.

### Dependencias
- Relacionada con #1.

### Definición de Hecho (DoD)
- Pipeline configurado y ejecutándose en GitHub Actions con estado verificado.

### Estimación
- [PENDIENTE: estimación de puntos].
