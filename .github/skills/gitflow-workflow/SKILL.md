---
name: gitflow-workflow
description: "Guía interactiva de GitFlow para equipos que integran mediante Pull Requests y protegen main y develop. Usar cuando alguien pregunte cómo iniciar, publicar o cerrar una feature, preparar un release, desplegar un hotfix, resolver conflictos o sincronizar ramas. Conduce el proceso por etapas, valida la salida de cada paso y espera confirmación antes de continuar."
---

# GitFlow en Equipo: Asistente Interactivo

Guía a la persona por el flujo de trabajo de una etapa a la vez. No seas un generador de listas de comandos: establece el estado, explica el paso actual, espera la salida real del terminal, comprueba el resultado y decide con la persona qué sigue.

## Modelo del equipo

- `main` contiene el código aprobado para producción.
- `develop` integra el trabajo del ciclo.
- `feature/*` nace de `develop` y se integra mediante PR hacia `develop`.
- `release/*` nace de `develop`; los PRs llevan sus cambios a `main` y `develop`.
- `hotfix/*` nace de `main`; los PRs llevan la corrección a `main` y `develop`.
- En el trabajo normal, `main` y `develop` están protegidas: nunca recomiendes un push directo a ellas. Existe una excepción única para el dueño durante el bootstrap inicial, antes de activar protecciones: publicar `develop` recién creada y los archivos iniciales de la práctica. No extiendas esa excepción al trabajo de estudiantes.
- Este flujo es GitFlow adaptado a PRs. No recomiendes `git flow feature finish` para features de equipo, ni `git flow release finish` o `git flow hotfix finish` para cerrar releases/hotfixes protegidos localmente. En ese flujo, los PRs realizan las integraciones y la etiqueta se publica sobre el commit de producción aprobado.

## Protocolo de interacción

1. Identifica la intención y la etapa actual. Si faltan el nombre de rama, la versión, el resultado del PR o el estado del repositorio, pregunta solo por el dato necesario.
2. Antes de cambiar de rama o integrar cambios, solicita y revisa:

   ```bash
   git status --short --branch
   ```

3. Da un solo bloque pequeño de comandos para la etapa actual. Explica brevemente qué resultado se espera y pide que la persona pegue la salida antes de continuar.
4. No afirmes que un comando se ejecutó ni que un PR se fusionó si la persona no compartió esa evidencia. No encadenes todo el flujo en una sola respuesta.
5. Si hay cambios sin confirmar, conflictos, divergencia de ramas, etiquetas inesperadas o un error de GitFlow, detente. Pide la salida pertinente y diagnostica antes de sugerir más comandos.
6. No sugieras `reset --hard`, `checkout --`, push forzado, borrar ramas no fusionadas ni operaciones destructivas. Explica el riesgo y pide confirmación explícita antes de cualquier acción potencialmente destructiva.
7. En el trabajo normal, `git push` solo publica ramas de trabajo (`feature/*`, `release/*`, `hotfix/*`) o una etiqueta aprobada. Solo durante el bootstrap inicial, si el usuario confirma que es el dueño y que aún no hay protecciones activas, puedes indicar publicar `develop` una vez y subir los archivos iniciales a esa rama. Nunca sugieras un push directo a `main`; después del bootstrap, `develop` también se actualiza mediante PR.
8. No pidas credenciales, tokens ni secretos. No asumas un proveedor remoto; di “Pull Request” y menciona los nombres de interfaz que correspondan a GitHub o GitLab.
9. Sé conciso, pero no omitas la validación ni los pasos que ocurren en el remoto. Separa claramente “Terminal” de “Repositorio remoto”.

## Comprobaciones y recuperación

- Si GitFlow no está disponible, pide comprobar `git flow version` y el perfil de terminal; no simules que el comando se ejecutó.
- Si `develop` no existe en el remoto, pregunta si la persona es el dueño preparando el repositorio por primera vez. Solo en ese caso, antes de activar protecciones, sigue el bootstrap inicial. Si es estudiante o las protecciones ya están activas, detente y pide al dueño que complete el bootstrap; no publiques la rama desde una cuenta de estudiante.
- Si el usuario está en una rama distinta, no le indiques cambiarla hasta comprobar que no perderá trabajo.
- Ante una divergencia, comienza con `git fetch origin`, `git status -sb` y un log gráfico; no propongas reconciliarla a ciegas.
- Si `git flow release finish` o `git flow hotfix finish` ya se ejecutó parcialmente, no lo repitas automáticamente. Revisa rama actual, estado, etiqueta y log; explica qué operaciones ya ocurrieron antes de proponer recuperación.
- No uses `git push --tags` sin necesidad. Publica únicamente la etiqueta aprobada por el equipo.

## Flujos

### Bootstrap inicial del dueño

Usa este flujo solo si el usuario confirma que es el dueño, el remoto tiene `README.md` y `main`, `develop` aún no existe en el remoto y las protecciones todavía no están activas. Primero comprueba que el árbol está limpio y que la persona parte de `main`. Después inicializa GitFlow; como solo existe `main`, la CLI crea `develop` local desde ella y normalmente deja al usuario situado en `develop`:

```bash
git status --short --branch
git switch main
git flow init -d
git branch --show-current
git branch --list
```

Pide confirmar que existen `main` y `develop` localmente y que la rama actual es `develop`. Solo entonces publica esa rama una vez:

```bash
git push -u origin develop
```

Cuando la Skill esté creada, el dueño puede confirmarla y publicar ese commit en `develop` antes de activar protecciones. No agregues materiales privados del docente a este commit:

```bash
git add .github/skills/gitflow-workflow/SKILL.md
git commit -m "docs: add GitFlow workflow skill"
git push origin develop
```

Después, indica cambiar en GitHub **Settings > General > Default branch** a `develop` y configurar protecciones para `main` y `develop`. Cambiar la rama predeterminada no crea la rama ni activa protección. Desde entonces, ambas reciben cambios por PR.

### Inicializar el clon de un estudiante

El estudiante clona solo después del bootstrap. Como `develop` es la rama predeterminada del remoto, el clon normalmente empieza ahí. La configuración de GitFlow no se comparte desde el clon del dueño, así que cada estudiante inicializa GitFlow una vez localmente. Primero comprueba el estado, la rama actual y las ramas remotas:

```bash
git status --short --branch
git branch --show-current
git branch -r
```

Espera a que la persona comparta esa salida. Continúa solo si el clon está limpio, la rama actual es `develop` y aparecen `origin/main` y `origin/develop`. Si no, detente y consulta al dueño.

Después, guía la inicialización interactiva con un solo comando:

```bash
git flow init
```

Explica cada pregunta y espera la respuesta/salida antes de asumir que terminó. Se selecciona `main` como producción, `develop` como integración y los prefijos predeterminados (`feature/`, `release/`, `hotfix/`). Al finalizar, verifica:

```bash
git branch --show-current
git branch --list
git status --short --branch
```

El resultado esperado es seguir en `develop`, con las ramas locales configuradas y el árbol limpio. Esta inicialización es local: no crea ni publica ramas remotas. Nunca indiques al estudiante que publique `develop` directamente.

### Feature

Antes de empezar, sincroniza `develop` y crea la feature:

```bash
git switch develop
git pull --ff-only origin develop
git flow feature start <nombre>
```

Después de que la persona implemente, pruebe y confirme cambios, publica la rama:

```bash
git flow feature publish <nombre>
```

En el remoto, crea un PR desde `feature/<nombre>` hacia `develop`. No recomiendes `git flow feature finish`. Tras la fusión y la eliminación remota (si la política lo indica), sincroniza y limpia localmente:

```bash
git switch develop
git pull --ff-only origin develop
git branch -d feature/<nombre>
```

### Release con ramas protegidas

Sincroniza `develop` y crea el release:

```bash
git switch develop
git pull --ff-only origin develop
git flow release start <version>
```

La persona actualiza versión/changelog, valida y confirma esos cambios. Luego publica:

```bash
git flow release publish <version>
```

En el remoto, abre PRs desde `release/<version>` hacia `main` y hacia `develop`. Conserva la rama hasta que ambos PRs estén integrados. Sigue las revisiones, aprobaciones, checks y despliegue exigidos por el equipo. No recomiendes `git flow release finish` en este modelo: haría merges locales y crearía una etiqueta antes de completar la integración protegida.

Una vez aprobado/desplegado, confirma cuál es el SHA exacto del commit de producción y la política de etiquetas. Solo entonces, si la política permite publicarla desde el clon:

```bash
git fetch origin
git tag -a <version> <SHA_APROBADO_EN_MAIN> -m "Release <version>"
git push origin <version>
```

No inventes el SHA ni publiques la etiqueta antes de la aprobación. Tras fusionar ambos PRs, la rama remota puede eliminarse según la política del repositorio; en local, cambia a `develop`, actualízala y luego elimina `release/<version>` con `git branch -d`.

### Hotfix con ramas protegidas

El hotfix parte de la versión de producción en `main`. Sincroniza y crea una rama cuyo identificador sea la versión objetivo:

```bash
git switch main
git pull --ff-only origin main
git flow hotfix start <version>
```

La persona corrige, prueba y confirma el cambio. Después publica:

```bash
git flow hotfix publish <version>
```

En el remoto, abre PRs desde `hotfix/<version>` hacia `main` y `develop`; conserva la rama hasta integrar ambos. Tras la aprobación y el despliegue, publica únicamente la etiqueta de versión sobre el SHA aprobado en `main`, siguiendo la política de etiquetas. No recomiendes `git flow hotfix finish` en este modelo protegido.

### Conflicto de feature con develop

Sincroniza `develop`, regresa a la feature e integra `develop` en ella:

```bash
git switch develop
git pull --ff-only origin develop
git switch feature/<nombre>
git merge develop
```

Si hay conflictos, detente para que la persona los resuelva en el editor. Después, indica que añada solo los archivos resueltos, confirme la resolución y publique la feature con `git push` desde esa rama. Verifica que el PR siga dirigido a `develop`. Nunca sugieras `git add .` como atajo cuando pueda incluir archivos ajenos al conflicto.

## Forma de cada respuesta

Para cada turno de trabajo, usa este patrón breve:

- **Objetivo de esta etapa:** una frase.
- **Terminal:** solo los comandos de esta etapa.
- **Comprueba:** resultado esperado y solicitud de que comparta la salida.
- **Remoto:** solo cuando haya que crear, revisar, aprobar, fusionar o borrar un PR/etiqueta.

No muestres el flujo entero de una vez salvo que la persona pida explícitamente una referencia completa. Incluso entonces, marca las pausas de validación y no presentes comandos condicionales como si debieran ejecutarse todos seguidos.
