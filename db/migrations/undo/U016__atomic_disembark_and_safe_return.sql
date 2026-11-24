-- ============================================================================
-- CAMINO SEGURO - REVERSIÓN DDL (UNDO MIGRATION)
-- Archivo: db/migrations/undo/U016__atomic_disembark_and_safe_return.sql
-- Revierte completamente V016__atomic_disembark_and_safe_return.sql (Issue #9)
-- ============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.fn_finalizar_custodia_sede_atomico(
    UUID, UUID, UUID, DOUBLE PRECISION, DOUBLE PRECISION, UUID, TEXT, VARCHAR
);

DROP FUNCTION IF EXISTS public.fn_registrar_descenso_atomico(
    UUID, UUID, VARCHAR, VARCHAR, VARCHAR, UUID, VARCHAR, DOUBLE PRECISION, DOUBLE PRECISION, UUID, TEXT, TEXT, VARCHAR, BOOLEAN
);

-- Restaurar la definición exacta de V014 para el bloqueo de cierre de viaje
CREATE OR REPLACE FUNCTION public.fn_bloquear_cierre_viaje_con_menores_a_bordo()
RETURNS TRIGGER AS $$
DECLARE
    v_menores_a_bordo INT;
BEGIN
    SELECT COUNT(*)
    INTO v_menores_a_bordo
    FROM public.viaje_estudiante
    WHERE id_viaje = NEW.id_viaje
      AND estado_custodia = 'A_BORDO_VEHICULO';

    IF v_menores_a_bordo > 0 THEN
        RAISE EXCEPTION 'BLOQUEO_CIERRE_VIAJE_CUSTODIA: No se puede cerrar el viaje % a FINALIZADO porque aun existen % estudiante(s) en estado A_BORDO_VEHICULO.',
            NEW.id_viaje, v_menores_a_bordo
            USING ERRCODE = '23514';
    END IF;

    NEW.hora_fin_real := COALESCE(NEW.hora_fin_real, clock_timestamp());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP INDEX IF EXISTS public.uq_entrega_idempotency_key;

ALTER TABLE public.entrega
    DROP COLUMN IF EXISTS idempotency_key;

ALTER TABLE public.entrega
    DROP CONSTRAINT IF EXISTS chk_entrega_estado_coherente;

ALTER TABLE public.entrega
    DROP CONSTRAINT IF EXISTS chk_entrega_tipo_receptor;

-- Normalizar valores nuevos antes de restaurar los CHECK originales de V006
UPDATE public.entrega
SET tipo_receptor = 'AUTORIZADO'
WHERE tipo_receptor = 'ADULTO_AUTORIZADO';

DELETE FROM public.entrega
WHERE tipo_receptor = 'SEDE_EDUCATIVA';

ALTER TABLE public.entrega
    ADD CONSTRAINT entrega_tipo_receptor_check
    CHECK (tipo_receptor IN ('ACUDIENTE', 'AUTORIZADO', 'RETORNO_SEDE_ESCOLAR'));

ALTER TABLE public.entrega
    ADD CONSTRAINT chk_entrega_estado_coherente
    CHECK (
        (estado_entrega = 'ENTREGADO_EXITOSO' AND tipo_receptor = 'ACUDIENTE' AND id_acudiente IS NOT NULL AND id_autorizado IS NULL) OR
        (estado_entrega = 'ENTREGADO_EXITOSO' AND tipo_receptor = 'AUTORIZADO' AND id_autorizado IS NOT NULL AND id_acudiente IS NULL) OR
        (estado_entrega = 'DESEMBARQUE_FALLIDO_RETORNO' AND tipo_receptor = 'RETORNO_SEDE_ESCOLAR' AND id_acudiente IS NULL AND id_autorizado IS NULL)
    );

COMMIT;
