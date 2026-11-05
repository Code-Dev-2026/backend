# Core Backend API — NestJS Clean Architecture

Repositorio base del backend estructurado bajo **Clean Architecture** con **NestJS 10**, **TypeScript** y validación de tipos estricta. Este proyecto sirve como plantilla base lista para la implementación modular guiada por las 23 Issues del proyecto.

---

## 🚀 Requisitos Previos

* **Node.js**: v20.x o superior
* **npm**: v10.x o superior
* **Git**: v2.40+

---

## 🛠️ Instalación y Puesta en Marcha

### 1. Clonar el repositorio y cambiar a la rama de trabajo
```bash
git clone https://github.com/Code-Dev-2026/backend.git
cd backend
```

### 2. Instalar dependencias
```bash
npm install
```

### 3. Configurar variables de entorno
Copia la plantilla `.env.example` para generar tu `.env` local:
```bash
cp .env.example .env
```

Contenido de `.env.example`:
```env
NODE_ENV=development
PORT=3000
API_PREFIX=api/v1
CORS_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173
```

### 4. Compilar el proyecto
```bash
npm run build
```

### 5. Ejecutar pruebas unitarias
```bash
npm test
```

### 6. Iniciar el servidor en modo desarrollo
```bash
npm run start:dev
```

El servidor estará disponible en `http://localhost:3000/api/v1`.  
La documentación interactiva de Swagger estará activa en: `http://localhost:3000/api/v1/docs`.

---

## 📁 Estructura del Proyecto

```text
.
├── .env.example              # Plantilla de variables de entorno mínimas
├── .gitignore                # Exclusiones de Git (node_modules, dist, .env)
├── CODEOWNERS                # Asignación de propietarios del repositorio
├── CONTRIBUTING.md           # Guía de contribución y GitHub Flow
├── LICENSE                   # Licencia del proyecto
├── nest-cli.json             # Configuración del CLI de NestJS
├── package.json              # Dependencias base y scripts npm
├── PULL_REQUEST_TEMPLATE.md  # Plantilla para Pull Requests
├── README.md                 # Documentación principal
├── SECURITY.md               # Política de divulgación de seguridad
├── tsconfig.json             # Configuración del compilador TypeScript y path aliases
├── tsconfig.build.json       # Configuración para la compilación de producción
├── .github/
│   └── ISSUE_TEMPLATE/       # Plantillas para reporte de bugs y features
├── docs/
│   └── issues/               # Especificación técnica de las 23 Issues oficiales
│       ├── issue-01.md
│       ├── issue-02.md
│       ├── ...
│       └── issue-23.md
└── src/
    ├── app.module.ts         # Módulo raíz de la aplicación
    ├── app.module.spec.ts    # Test unitario base del módulo raíz
    ├── main.ts               # Punto de entrada (Bootstrap, Helmet, CORS, Swagger)
    ├── common/               # Filtros, interceptores y pipes transversales
    │   ├── index.ts
    │   ├── filters/          # AllExceptionsFilter
    │   ├── interceptors/      # LoggingInterceptor, TransformInterceptor
    │   └── pipes/             # ParseUuidV7Pipe
    └── config/               # Validación de variables de entorno (Joi)
        └── env.validation.ts
```

---

## 👥 Flujo de Trabajo para Implementar las Issues (GitHub Flow)

Todas las funcionalidades se implementan siguiendo **GitHub Flow**:

1. **Revisar la Issue asignada:**
   Consulta la especificación correspondiente en `docs/issues/issue-XX.md` o en las [GitHub Issues](https://github.com/Code-Dev-2026/backend/issues).
2. **Crear una rama con la convención oficial:**
   ```bash
   git checkout -b feat/issue-XX-nombre-corto
   ```
   *Ejemplo: `git checkout -b feat/issue-03-auth-jwt`*
3. **Desarrollar y realizar commits con Conventional Commits:**
   * `feat:` Nueva funcionalidad o caso de uso.
   * `fix:` Corrección de errores.
   * `test:` Adición de pruebas unitarias o de integración.
   * `docs:` Cambios en documentación.
   * `refactor:` Refactorización de código sin cambiar comportamiento.
4. **Verificar calidad local antes de enviar:**
   ```bash
   npm run build
   npm test
   npm run lint
   ```
5. **Crear Pull Request referenciando la Issue:**
   En el cuerpo del PR incluir la palabra clave de cierre (ej: `Resolves #3` o `Closes #3`).

---

## 📜 Scripts Disponibles

* `npm run build`: Compila la aplicación en la carpeta `dist/`.
* `npm run start`: Inicia la aplicación en modo producción.
* `npm run start:dev`: Inicia la aplicación con recarga automática en caliente (watch mode).
* `npm run start:debug`: Inicia la aplicación en modo depuración.
* `npm test`: Ejecuta las pruebas unitarias con Jest.
* `npm run test:watch`: Ejecuta las pruebas en modo observador.
* `npm run test:cov`: Genera el reporte de cobertura de pruebas.
* `npm run lint`: Analiza y formatea el código con ESLint.
* `npm run format`: Formatea el código con Prettier.
