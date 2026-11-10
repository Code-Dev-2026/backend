#!/usr/bin/env bash
# ============================================================================
# SCRIPT DE VERIFICACIÓN AUTOMATIZADA DE MIGRACIONES (LINUX / CI)
# Proyecto: Camino Seguro - Backend Core (Issue #2)
# ============================================================================

set -euo pipefail

DB_HOST="${POSTGRES_HOST:-localhost}"
DB_PORT="${POSTGRES_PORT:-5432}"
DB_NAME="${POSTGRES_DB:-camino_seguro_db}"
DB_USER="${POSTGRES_USER:-postgres}"
export PGPASSWORD="${POSTGRES_PASSWORD:-${PGPASSWORD:-}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$(dirname "$SCRIPT_DIR")"
MIGRATIONS_DIR="$BASE_DIR/migrations"
VALIDATION_SCRIPT="$SCRIPT_DIR/test-validation-queries.sql"

echo "============================================================"
echo " VERIFICADOR DE MIGRACIONES DDL POSTGRESQL 16 + POSTGIS 3.4"
echo " Base de Datos : $DB_NAME"
echo " Host          : $DB_HOST:$DB_PORT"
echo " Usuario       : $DB_USER"
echo "============================================================"

echo ""
echo "[PASO 1] Ejecutando migraciones secuenciales V001 a V010..."

for file in $(ls "$MIGRATIONS_DIR"/V*.sql | sort -V); do
    echo "  -> Aplicando migración: $(basename "$file")"
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -f "$file"
done

echo ""
echo "[PASO 2] Ejecutando consultas de validación e invariantes..."
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -f "$VALIDATION_SCRIPT"

echo ""
echo "============================================================"
echo " ÉXITO: TODAS LAS MIGRACIONES Y REGLAS DE NEGOCIO PASARON (0)"
echo "============================================================"
exit 0

