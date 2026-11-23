-- ============================================================================
-- CAMINO SEGURO - REVERSIÓN DDL (UNDO MIGRATION)
-- Archivo: db/migrations/undo/U015__atomic_boarding_and_overcapacity.sql
-- Revierte completamente V015__atomic_boarding_and_overcapacity.sql (Issue #8)
-- ============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.fn_registrar_abordaje_atomico(
    UUID, UUID, VARCHAR, VARCHAR, DOUBLE PRECISION, DOUBLE PRECISION, UUID, VARCHAR, BOOLEAN
);

DROP INDEX IF EXISTS public.uq_asistencia_idempotency_key;

ALTER TABLE public.registro_de_asistencia
    DROP COLUMN IF EXISTS idempotency_key;

COMMIT;
