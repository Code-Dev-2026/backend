#!/usr/bin/env bash
# ============================================================================
# Generador local de certificados mTLS y archivo de contraseñas para Mosquitto
# Proyecto: Camino Seguro — Issue #12 (solo desarrollo/pruebas locales)
# Sin secretos quemados: las contraseñas se leen de variables de entorno.
# ============================================================================
set -euo pipefail

BACKEND_PASSWORD="${MQTT_BACKEND_PASSWORD:-}"
VEHICLE_PLATE="${MQTT_VEHICLE_PLATE:-WKK123}"
VEHICLE_PASSWORD="${MQTT_VEHICLE_WKK123_PASSWORD:-}"

if [[ -z "${BACKEND_PASSWORD}" ]]; then
  echo "ERROR: Debe definir MQTT_BACKEND_PASSWORD." >&2
  exit 1
fi

if [[ -z "${VEHICLE_PASSWORD}" ]]; then
  echo "ERROR: Debe definir MQTT_VEHICLE_WKK123_PASSWORD." >&2
  exit 1
fi

if [[ ! "${VEHICLE_PLATE}" =~ ^[A-Z0-9_-]{3,16}$ ]]; then
  echo "ERROR: Placa/identificador de vehículo inválido: ${VEHICLE_PLATE}" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERTS_DIR="${SCRIPT_DIR}/certs"
mkdir -p "${CERTS_DIR}"

docker run --rm -v "${CERTS_DIR}:/certs" alpine/openssl req -x509 -nodes -newkey rsa:2048 \
  -days 365 -subj "/CN=CaminoSeguro-Dev-CA" \
  -keyout /certs/ca.key -out /certs/ca.crt

cat > "${CERTS_DIR}/server-ext.cnf" <<EOF
subjectAltName=DNS:localhost,DNS:mosquitto,IP:127.0.0.1
extendedKeyUsage=serverAuth
EOF

docker run --rm -v "${CERTS_DIR}:/certs" alpine/openssl req -nodes -newkey rsa:2048 \
  -subj "/CN=localhost" \
  -keyout /certs/server.key -out /certs/server.csr

docker run --rm -v "${CERTS_DIR}:/certs" alpine/openssl x509 -req -in /certs/server.csr \
  -CA /certs/ca.crt -CAkey /certs/ca.key -CAcreateserial \
  -out /certs/server.crt -days 365 -extfile /certs/server-ext.cnf

docker run --rm -v "${CERTS_DIR}:/certs" alpine/openssl req -nodes -newkey rsa:2048 \
  -subj "/CN=backend_telemetry" \
  -keyout /certs/backend.key -out /certs/backend.csr

docker run --rm -v "${CERTS_DIR}:/certs" alpine/openssl x509 -req -in /certs/backend.csr \
  -CA /certs/ca.crt -CAkey /certs/ca.key -CAcreateserial \
  -out /certs/backend.crt -days 365

docker run --rm -v "${CERTS_DIR}:/certs" alpine/openssl req -nodes -newkey rsa:2048 \
  -subj "/CN=${VEHICLE_PLATE}" \
  -keyout "/certs/vehicle-${VEHICLE_PLATE}.key" -out "/certs/vehicle-${VEHICLE_PLATE}.csr"

docker run --rm -v "${CERTS_DIR}:/certs" alpine/openssl x509 -req -in "/certs/vehicle-${VEHICLE_PLATE}.csr" \
  -CA /certs/ca.crt -CAkey /certs/ca.key -CAcreateserial \
  -out "/certs/vehicle-${VEHICLE_PLATE}.crt" -days 365

rm -f "${CERTS_DIR}/server.csr" "${CERTS_DIR}/server-ext.cnf" "${CERTS_DIR}/backend.csr" "${CERTS_DIR}/vehicle-${VEHICLE_PLATE}.csr"

: > "${SCRIPT_DIR}/passwd"
docker run --rm -v "${SCRIPT_DIR}:/mosquitto/config" eclipse-mosquitto:2.0 \
  mosquitto_passwd -b /mosquitto/config/passwd backend_telemetry "${BACKEND_PASSWORD}"

docker run --rm -v "${SCRIPT_DIR}:/mosquitto/config" eclipse-mosquitto:2.0 \
  mosquitto_passwd -b /mosquitto/config/passwd "${VEHICLE_PLATE}" "${VEHICLE_PASSWORD}"

echo "OK: Certificados mTLS y archivo passwd generados en docker/mosquitto/ (excluidos de Git)."
