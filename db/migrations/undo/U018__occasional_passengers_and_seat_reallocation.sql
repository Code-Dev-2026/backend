-- ============================================================================
-- CAMINO SEGURO - REVERSIÓN DDL (UNDO MIGRATION)
-- Archivo: db/migrations/undo/U018__occasional_passengers_and_seat_reallocation.sql
-- Revierte completamente V018__occasional_passengers_and_seat_reallocation.sql (Issue #11)
-- ============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.fn_aprobar_pasajero_ocasional(UUID, UUID, UUID);

DROP FUNCTION IF EXISTS public.fn_solicitar_pasajero_ocasional(
    UUID, UUID, UUID, VARCHAR, TEXT, TIMESTAMPTZ
);

DROP FUNCTION IF EXISTS public.fn_evaluar_balance_vacantes_viaje(UUID);

DROP TRIGGER IF EXISTS trg_proteger_inasistencia_cupo_asignado ON public.inasistencia;

DROP FUNCTION IF EXISTS public.fn_proteger_inasistencia_cupo_asignado();

DROP INDEX IF EXISTS public.idx_pasajero_ocasional_acudiente;

DROP INDEX IF EXISTS public.uq_pasajero_ocasional_estudiante_viaje;

ALTER TABLE public.pasajero_ocasional
    DROP CONSTRAINT IF EXISTS chk_pasajero_ocasional_distinto_liberador;

ALTER TABLE public.pasajero_ocasional
    DROP COLUMN IF EXISTS motivo,
    DROP COLUMN IF EXISTS solicitado_por_acudiente;

COMMIT;
