-- ============================================================================
-- CAMINO SEGURO - REVERSIÓN DDL (UNDO MIGRATION)
-- Archivo: db/migrations/undo/U014__custody_fsm_and_worm_functions.sql
-- Revierte completamente V014__custody_fsm_and_worm_functions.sql (Issue #7)
-- ============================================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_bloquear_cierre_viaje_con_menores_a_bordo ON public.viaje;
DROP FUNCTION IF EXISTS public.fn_bloquear_cierre_viaje_con_menores_a_bordo();
DROP FUNCTION IF EXISTS public.fn_inicializar_custodia_matutina(DATE);
DROP FUNCTION IF EXISTS public.fn_registrar_transicion_custodia(
    UUID, UUID, VARCHAR, VARCHAR, VARCHAR, UUID, DOUBLE PRECISION, DOUBLE PRECISION
);
DROP FUNCTION IF EXISTS public.fn_validar_transicion_custodia(VARCHAR, VARCHAR, VARCHAR);

ALTER TABLE public.viaje_estudiante
    DROP CONSTRAINT IF EXISTS chk_viaje_estudiante_estado_custodia;

UPDATE public.viaje_estudiante
SET estado_custodia = CASE estado_custodia
    WHEN 'NO_INICIADO' THEN 'EN_CASA_ESPERA'
    WHEN 'EN_ESPERA_ABORDAJE' THEN 'EN_CASA_ESPERA'
    WHEN 'EN_COLEGIO' THEN 'EN_CUSTODIA_INSTITUCIONAL'
    WHEN 'ENTREGADO_ACUDIENTE' THEN 'ENTREGADO_ADULTO_AUTORIZADO'
    WHEN 'RETORNO_SEDE_POR_FALLA_ENTREGA' THEN 'RETORNO_SEGURO_SEDE'
    ELSE estado_custodia
END
WHERE estado_custodia IN (
    'NO_INICIADO',
    'EN_ESPERA_ABORDAJE',
    'EN_COLEGIO',
    'ENTREGADO_ACUDIENTE',
    'RETORNO_SEDE_POR_FALLA_ENTREGA'
);

ALTER TABLE public.viaje_estudiante
    ALTER COLUMN estado_custodia SET DEFAULT 'EN_CASA_ESPERA';

ALTER TABLE public.viaje_estudiante
    ADD CONSTRAINT viaje_estudiante_estado_custodia_check
    CHECK (estado_custodia IN (
        'EN_CASA_ESPERA',
        'A_BORDO_VEHICULO',
        'ENTREGADO_ADULTO_AUTORIZADO',
        'RETORNO_SEGURO_SEDE',
        'EN_CUSTODIA_INSTITUCIONAL',
        'AUSENTE_CONFIRMADO'
    ));

COMMIT;
