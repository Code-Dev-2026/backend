# ============================================================================
# Generador local de certificados mTLS y archivo de contraseñas para Mosquitto
# Proyecto: Camino Seguro — Issue #12 (solo desarrollo/pruebas locales)
# Sin secretos quemados: las contraseñas se leen estrictamente de variables de entorno.
# ============================================================================

param(
    [string]$BackendPassword = $env:MQTT_BACKEND_PASSWORD,
    [string]$VehiclePlate = "WKK123",
    [string]$VehiclePassword = $env:MQTT_VEHICLE_WKK123_PASSWORD
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($BackendPassword)) {
    Write-Error "Debe definir MQTT_BACKEND_PASSWORD (variable de entorno o parámetro -BackendPassword)."
    exit 1
}

if ([string]::IsNullOrWhiteSpace($VehiclePassword)) {
    Write-Error "Debe definir MQTT_VEHICLE_WKK123_PASSWORD (variable de entorno o parámetro -VehiclePassword)."
    exit 1
}

if ($VehiclePlate -notmatch '^[A-Z0-9_-]{3,16}$') {
    Write-Error "Placa/identificador de vehículo inválido: $VehiclePlate"
    exit 1
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$CertsDir = Join-Path $ScriptDir "certs"
New-Item -ItemType Directory -Force -Path $CertsDir | Out-Null

$CertsMount = "${CertsDir}:/certs"
$ConfigMount = "${ScriptDir}:/mosquitto/config"

Write-Host "[1/4] Generando Autoridad Certificadora (CA) local..." -ForegroundColor Cyan
docker run --rm -v $CertsMount alpine/openssl req -x509 -nodes -newkey rsa:2048 `
    -days 365 -subj "/CN=CaminoSeguro-Dev-CA" `
    -keyout /certs/ca.key -out /certs/ca.crt

Write-Host "[2/4] Generando certificado TLS del servidor Mosquitto (SAN localhost/mosquitto/127.0.0.1)..." -ForegroundColor Cyan
$ExtContent = @"
subjectAltName=DNS:localhost,DNS:mosquitto,IP:127.0.0.1
extendedKeyUsage=serverAuth
"@
$ExtPath = Join-Path $CertsDir "server-ext.cnf"
[System.IO.File]::WriteAllText($ExtPath, $ExtContent)

docker run --rm -v $CertsMount alpine/openssl req -nodes -newkey rsa:2048 `
    -subj "/CN=localhost" `
    -keyout /certs/server.key -out /certs/server.csr

docker run --rm -v $CertsMount alpine/openssl x509 -req -in /certs/server.csr `
    -CA /certs/ca.crt -CAkey /certs/ca.key -CAcreateserial `
    -out /certs/server.crt -days 365 -extfile /certs/server-ext.cnf

Write-Host "[3/4] Generando certificados mTLS cliente (backend_telemetry y $VehiclePlate)..." -ForegroundColor Cyan
docker run --rm -v $CertsMount alpine/openssl req -nodes -newkey rsa:2048 `
    -subj "/CN=backend_telemetry" `
    -keyout /certs/backend.key -out /certs/backend.csr

docker run --rm -v $CertsMount alpine/openssl x509 -req -in /certs/backend.csr `
    -CA /certs/ca.crt -CAkey /certs/ca.key -CAcreateserial `
    -out /certs/backend.crt -days 365

docker run --rm -v $CertsMount alpine/openssl req -nodes -newkey rsa:2048 `
    -subj "/CN=$VehiclePlate" `
    -keyout "/certs/vehicle-$VehiclePlate.key" -out "/certs/vehicle-$VehiclePlate.csr"

docker run --rm -v $CertsMount alpine/openssl x509 -req -in "/certs/vehicle-$VehiclePlate.csr" `
    -CA /certs/ca.crt -CAkey /certs/ca.key -CAcreateserial `
    -out "/certs/vehicle-$VehiclePlate.crt" -days 365

Remove-Item -Force -ErrorAction SilentlyContinue `
    (Join-Path $CertsDir "server.csr"), `
    (Join-Path $CertsDir "server-ext.cnf"), `
    (Join-Path $CertsDir "backend.csr"), `
    (Join-Path $CertsDir "vehicle-$VehiclePlate.csr")

Write-Host "[4/4] Generando archivo de contraseñas encriptadas (docker/mosquitto/passwd)..." -ForegroundColor Cyan
$PasswdFile = Join-Path $ScriptDir "passwd"
if (Test-Path $PasswdFile) { Remove-Item -Force $PasswdFile }
New-Item -ItemType File -Force -Path $PasswdFile | Out-Null

docker run --rm -v $ConfigMount eclipse-mosquitto:2.0 `
    mosquitto_passwd -b /mosquitto/config/passwd backend_telemetry $BackendPassword

docker run --rm -v $ConfigMount eclipse-mosquitto:2.0 `
    mosquitto_passwd -b /mosquitto/config/passwd $VehiclePlate $VehiclePassword

Write-Host "OK: Certificados mTLS y archivo passwd generados en docker/mosquitto/ (excluidos de Git)." -ForegroundColor Green
