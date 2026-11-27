-- ============================================================================
-- CAMINO SEGURO - REVERSIÓN DDL (UNDO MIGRATION)
-- Archivo: db/migrations/undo/U019__telemetry_gps_ingestion_and_partitions.sql
-- Revierte completamente V019__telemetry_gps_ingestion_and_partitions.sql (Issue #12)
-- ============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.fn_purgar_particiones_gps_vencidas(INT, TIMESTAMPTZ);

DROP FUNCTION IF EXISTS public.fn_crear_particion_gps_mensual(TIMESTAMPTZ, INT);

DROP INDEX IF EXISTS public.idx_gps_vehiculo_tiempo;

DROP INDEX IF EXISTS public.uq_registro_gps_vehiculo_fecha;

ALTER TABLE public.registro_gps
    DROP CONSTRAINT IF EXISTS chk_registro_gps_rumbo_grados,
    DROP CONSTRAINT IF EXISTS chk_registro_gps_velocidad_kmh,
    DROP CONSTRAINT IF EXISTS chk_registro_gps_odometro_km,
    DROP CONSTRAINT IF EXISTS chk_registro_gps_precision_metros;

ALTER TABLE public.registro_gps
    DROP COLUMN IF EXISTS odometro_km,
    DROP COLUMN IF EXISTS precision_metros;

COMMIT;
