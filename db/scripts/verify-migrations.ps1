# ============================================================================
# SCRIPT DE VERIFICACIÓN AUTOMATIZADA DE MIGRACIONES (WINDOWS POWERSHELL)
# Proyecto: Camino Seguro - Backend Core (Issue #2)
# ============================================================================

param(
    [string]$HostName = $env:POSTGRES_HOST,
    [string]$Port = $env:POSTGRES_PORT,
    [string]$Database = $env:POSTGRES_DB,
    [string]$User = $env:POSTGRES_USER,
    [string]$Password = $env:POSTGRES_PASSWORD
)

if (-not $HostName) { $HostName = "localhost" }
if (-not $Port) { $Port = "5432" }
if (-not $Database) { $Database = "camino_seguro_db" }
if (-not $User) { $User = "postgres" }
if (-not $Password) { 
    if ($env:PGPASSWORD) {
        $Password = $env:PGPASSWORD
    }
}

$env:PGPASSWORD = $Password

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BaseDir = Split-Path -Parent $ScriptDir
$MigrationsDir = Join-Path $BaseDir "migrations"
$ValidationScript = Join-Path $ScriptDir "test-validation-queries.sql"

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " VERIFICADOR DE MIGRACIONES DDL POSTGRESQL 16 + POSTGIS 3.4" -ForegroundColor Cyan
Write-Host " Base de Datos : $Database" -ForegroundColor Cyan
Write-Host " Host          : ${HostName}:${Port}" -ForegroundColor Cyan
Write-Host " Usuario       : $User" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

# Detectar psql local o psql vía Docker
$PsqlCmd = Get-Command "psql" -ErrorAction SilentlyContinue
$UseDocker = $false

if (-not $PsqlCmd) {
    # Intentar rutas comunes de PostgreSQL en Windows
    $CommonPaths = @(
        "C:\Program Files\PostgreSQL\16\bin\psql.exe",
        "C:\Program Files\PostgreSQL\15\bin\psql.exe"
    )
    foreach ($path in $CommonPaths) {
        if (Test-Path $path) {
            $PsqlExecutable = $path
            break
        }
    }
} else {
    $PsqlExecutable = "psql"
}

if (-not $PsqlExecutable) {
    # Verificar si el contenedor Docker camino-seguro-postgres está activo
    $DockerRunning = docker ps --filter "name=camino-seguro-postgres" --format "{{.Names}}" 2>$null
    if ($DockerRunning -match "camino-seguro-postgres") {
        Write-Host "[INFO] psql nativo no encontrado. Usando contenedor Docker 'camino-seguro-postgres'..." -ForegroundColor Yellow
        $UseDocker = $true
    } else {
        Write-Error "ERROR: Ni 'psql' ni el contenedor Docker 'camino-seguro-postgres' estan disponibles para la verificacion."
        exit 1
    }
}

# 1. Obtener y ordenar migraciones V001 a V010
$MigrationFiles = Get-ChildItem -Path $MigrationsDir -Filter "V*.sql" | Sort-Object Name

if ($MigrationFiles.Count -eq 0) {
    Write-Error "ERROR: No se encontraron archivos de migracion en $MigrationsDir"
    exit 1
}

Write-Host "`n[PASO 1] Ejecutando $($MigrationFiles.Count) migraciones secuenciales..." -ForegroundColor Green

foreach ($file in $MigrationFiles) {
    Write-Host "  -> Aplicando migración: $($file.Name)" -ForegroundColor Gray
    
    if ($UseDocker) {
        Get-Content $file.FullName | docker exec -i camino-seguro-postgres psql -U $User -d $Database -v ON_ERROR_STOP=1
    } else {
        & $PsqlExecutable -h $HostName -p $Port -U $User -d $Database -v ON_ERROR_STOP=1 -f $file.FullName
    }

    if ($LASTEXITCODE -ne 0) {
        Write-Error "FALLO: Error al aplicar $($file.Name) (Código de salida: $LASTEXITCODE)"
        exit $LASTEXITCODE
    }
}

Write-Host "`n[PASO 2] Ejecutando suite de consultas de validacion y pruebas negativas..." -ForegroundColor Green

if ($UseDocker) {
    Get-Content $ValidationScript | docker exec -i camino-seguro-postgres psql -U $User -d $Database -v ON_ERROR_STOP=1
} else {
    & $PsqlExecutable -h $HostName -p $Port -U $User -d $Database -v ON_ERROR_STOP=1 -f $ValidationScript
}

if ($LASTEXITCODE -ne 0) {
    Write-Error "FALLO: Las pruebas de validacion arrojaron errores (Codigo de salida: $LASTEXITCODE)"
    exit $LASTEXITCODE
}

Write-Host "`n============================================================" -ForegroundColor Green
Write-Host " EXITO: TODAS LAS MIGRACIONES Y REGLAS DE NEGOCIO PASARON (0)" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
exit 0

