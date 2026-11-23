-- ============================================================================
-- CAMINO SEGURO - BACKEND CORE DDL (POSTGRESQL 16 + POSTGIS 3.4)
-- Archivo: V012__enrollment_import_ledger.sql
-- Issue #5: Importación masiva de matrículas con idempotencia por SHA-256
-- Un registro por archivo importado. La reserva (EN_PROCESO) se hace con
--   INSERT ... ON CONFLICT (hash_sha256) DO NOTHING RETURNING *
-- para que dos cargas simultáneas del mismo archivo no se procesen dos veces.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS importacion_matricula (
    id_importacion UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    hash_sha256 VARCHAR(64) NOT NULL UNIQUE CHECK (hash_sha256 ~ '^[0-9a-f]{64}$'),
    estado VARCHAR(20) NOT NULL CHECK (estado IN ('EN_PROCESO', 'COMPLETADA')),
    id_usuario UUID NOT NULL REFERENCES usuario(id_usuario) ON DELETE RESTRICT,
    id_colegio UUID NOT NULL REFERENCES colegio(id_colegio) ON DELETE RESTRICT,
    tipo_archivo VARCHAR(10) NOT NULL CHECK (tipo_archivo IN ('CSV', 'XLSX')),
    tamano_bytes INT NOT NULL CHECK (tamano_bytes > 0),
    filas_creadas INT NOT NULL DEFAULT 0 CHECK (filas_creadas >= 0),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    completado_en TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_importacion_matricula_colegio ON importacion_matricula(id_colegio);

COMMENT ON TABLE importacion_matricula IS 'Bitácora de cargas masivas de matrícula; hash_sha256 impide importar dos veces el mismo archivo';

COMMIT;
