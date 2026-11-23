-- ============================================================================
-- CAMINO SEGURO - REVERSIÓN DDL (UNDO MIGRATION)
-- Archivo: db/migrations/undo/U013__geo_san_benito_geofence.sql
-- Revierte completamente V013__geo_san_benito_geofence.sql (Issue #6)
-- ============================================================================

BEGIN;

DELETE FROM public.zona_geografica
WHERE codigo = 'GEOCERCA-SAN-BENITO-OTUN';

DROP INDEX IF EXISTS public.idx_zona_geografica_colegio;
DROP INDEX IF EXISTS public.idx_zona_geografica_tipo_activa;
DROP INDEX IF EXISTS public.uq_zona_geografica_codigo;

ALTER TABLE public.zona_geografica
    DROP COLUMN IF EXISTS id_colegio,
    DROP COLUMN IF EXISTS codigo;

ALTER TABLE public.parada
    DROP CONSTRAINT IF EXISTS chk_parada_orden_positivo;

COMMIT;
