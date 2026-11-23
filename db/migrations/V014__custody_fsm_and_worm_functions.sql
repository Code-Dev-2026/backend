-- ============================================================================
-- CAMINO SEGURO - BACKEND CORE DDL (POSTGRESQL 16 + POSTGIS 3.4)
-- Archivo: V014__custody_fsm_and_worm_functions.sql
-- Issue #7: Ciclo de custodia física, máquina de estados FSM y persistencia WORM
-- Requisitos SRS: RF-06, RF-07, RN-01, RNF-01, OWASP ASVS V1.14
-- Reversible mediante: db/migrations/undo/U014__custody_fsm_and_worm_functions.sql
-- ============================================================================

BEGIN;

-- 1. Alinear estados de viaje_estudiante.estado_custodia al dominio FSM del Issue #7
--    NO_INICIADO -> EN_ESPERA_ABORDAJE -> A_BORDO_VEHICULO -> EN_COLEGIO (mañana)
--    o ENTREGADO_ACUDIENTE (tarde) | RETORNO_SEDE_POR_FALLA_ENTREGA -> EN_COLEGIO
DO $$
DECLARE
    v_constraint_name TEXT;
BEGIN
    FOR v_constraint_name IN (
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid
         AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = 'public.viaje_estudiante'::regclass
          AND c.contype = 'c'
          AND a.attname = 'estado_custodia'
    ) LOOP
        EXECUTE format(
            'ALTER TABLE public.viaje_estudiante DROP CONSTRAINT %I;',
            v_constraint_name
        );
    END LOOP;
END $$;

UPDATE public.viaje_estudiante
SET estado_custodia = CASE estado_custodia
    WHEN 'EN_CASA_ESPERA' THEN 'NO_INICIADO'
    WHEN 'EN_CUSTODIA_INSTITUCIONAL' THEN 'EN_COLEGIO'
    WHEN 'ENTREGADO_ADULTO_AUTORIZADO' THEN 'ENTREGADO_ACUDIENTE'
    WHEN 'RETORNO_SEGURO_SEDE' THEN 'RETORNO_SEDE_POR_FALLA_ENTREGA'
    WHEN 'AUSENTE_CONFIRMADO' THEN 'NO_INICIADO'
    ELSE estado_custodia
END
WHERE estado_custodia IN (
    'EN_CASA_ESPERA',
    'EN_CUSTODIA_INSTITUCIONAL',
    'ENTREGADO_ADULTO_AUTORIZADO',
    'RETORNO_SEGURO_SEDE',
    'AUSENTE_CONFIRMADO'
);

ALTER TABLE public.viaje_estudiante
    ALTER COLUMN estado_custodia SET DEFAULT 'NO_INICIADO';

ALTER TABLE public.viaje_estudiante
    ADD CONSTRAINT chk_viaje_estudiante_estado_custodia
    CHECK (estado_custodia IN (
        'NO_INICIADO',
        'EN_ESPERA_ABORDAJE',
        'A_BORDO_VEHICULO',
        'EN_COLEGIO',
        'ENTREGADO_ACUDIENTE',
        'RETORNO_SEDE_POR_FALLA_ENTREGA'
    ));

-- 2. Función pura de validación de la matriz unidireccional de transiciones FSM (RN-01)
CREATE OR REPLACE FUNCTION public.fn_validar_transicion_custodia(
    p_estado_origen VARCHAR(30),
    p_estado_destino VARCHAR(30),
    p_tipo_recorrido VARCHAR(10)
)
RETURNS BOOLEAN AS $$
BEGIN
    IF p_tipo_recorrido NOT IN ('MANANA', 'TARDE') THEN
        RETURN FALSE;
    END IF;

    IF p_estado_origen = 'NO_INICIADO' AND p_estado_destino = 'EN_ESPERA_ABORDAJE' THEN
        RETURN TRUE;
    ELSIF p_estado_origen = 'EN_ESPERA_ABORDAJE' AND p_estado_destino = 'A_BORDO_VEHICULO' THEN
        RETURN TRUE;
    ELSIF p_estado_origen = 'A_BORDO_VEHICULO'
      AND p_estado_destino = 'EN_COLEGIO'
      AND p_tipo_recorrido = 'MANANA' THEN
        RETURN TRUE;
    ELSIF p_estado_origen = 'A_BORDO_VEHICULO'
      AND p_estado_destino = 'ENTREGADO_ACUDIENTE'
      AND p_tipo_recorrido = 'TARDE' THEN
        RETURN TRUE;
    ELSIF p_estado_origen = 'A_BORDO_VEHICULO'
      AND p_estado_destino = 'RETORNO_SEDE_POR_FALLA_ENTREGA'
      AND p_tipo_recorrido = 'TARDE' THEN
        RETURN TRUE;
    ELSIF p_estado_origen = 'RETORNO_SEDE_POR_FALLA_ENTREGA'
      AND p_estado_destino = 'EN_COLEGIO'
      AND p_tipo_recorrido = 'TARDE' THEN
        RETURN TRUE;
    END IF;

    RETURN FALSE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 3. Función almacenada atómica para transición FSM + inserción encadenada SHA-256 WORM
CREATE OR REPLACE FUNCTION public.fn_registrar_transicion_custodia(
    p_id_viaje UUID,
    p_id_estudiante UUID,
    p_estado_destino VARCHAR(30),
    p_tipo_recorrido VARCHAR(10),
    p_disparador_evento VARCHAR(50),
    p_registrado_por_usuario UUID DEFAULT NULL,
    p_latitud DOUBLE PRECISION DEFAULT NULL,
    p_longitud DOUBLE PRECISION DEFAULT NULL
)
RETURNS TABLE (
    id_historial UUID,
    secuencia BIGINT,
    id_estudiante UUID,
    id_viaje UUID,
    estado_origen VARCHAR(30),
    estado_destino VARCHAR(30),
    disparador_evento VARCHAR(50),
    fecha_hora TIMESTAMPTZ,
    registrado_por_usuario UUID,
    hash_sha256_anterior VARCHAR(64),
    hash_sha256_actual VARCHAR(64)
) AS $$
#variable_conflict use_column
DECLARE
    v_estado_origen VARCHAR(30);
    v_geog GEOGRAPHY(Point, 4326) := NULL;
    v_ahora TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF p_tipo_recorrido IS NULL OR p_tipo_recorrido NOT IN ('MANANA', 'TARDE') THEN
        RAISE EXCEPTION 'VIOLACION_INVARIANTE_FSM: Tipo de recorrido invalido (%). Debe ser MANANA o TARDE.', COALESCE(p_tipo_recorrido, 'NULL')
            USING ERRCODE = '23514';
    END IF;

    IF (p_latitud IS NULL) <> (p_longitud IS NULL) THEN
        RAISE EXCEPTION 'COORDENADAS_INCOMPLETAS: Latitud y longitud deben proporcionarse juntas o omitirse.'
            USING ERRCODE = '22023';
    END IF;

    IF p_latitud IS NOT NULL THEN
        IF p_latitud < -90 OR p_latitud > 90 OR p_longitud < -180 OR p_longitud > 180 THEN
            RAISE EXCEPTION 'COORDENADAS_INVALIDAS: Rango WGS84 excedido (lat %, lon %).', p_latitud, p_longitud
                USING ERRCODE = '22023';
        END IF;
        v_geog := ST_SetSRID(ST_MakePoint(p_longitud, p_latitud), 4326)::geography;
    END IF;

    -- Bloqueo pesimista sobre la matrícula operativa del estudiante en el viaje
    SELECT ve.estado_custodia
    INTO v_estado_origen
    FROM public.viaje_estudiante ve
    WHERE ve.id_viaje = p_id_viaje
      AND ve.id_estudiante = p_id_estudiante
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'MATRICULA_VIAJE_NO_ENCONTRADA: El estudiante % no esta registrado en el viaje %.', p_id_estudiante, p_id_viaje
            USING ERRCODE = 'P0002';
    END IF;

    -- Validación estricta de invariante FSM (RN-01)
    IF NOT public.fn_validar_transicion_custodia(v_estado_origen, p_estado_destino, p_tipo_recorrido) THEN
        RAISE EXCEPTION 'VIOLACION_INVARIANTE_FSM: Transicion invalida de % hacia % para recorrido %.', v_estado_origen, p_estado_destino, p_tipo_recorrido
            USING ERRCODE = '23514';
    END IF;

    -- Actualizar estado actual de custodia en viaje_estudiante
    UPDATE public.viaje_estudiante
    SET estado_custodia = p_estado_destino,
        hora_abordaje = CASE
            WHEN p_estado_destino = 'A_BORDO_VEHICULO' THEN COALESCE(hora_abordaje, v_ahora)
            ELSE hora_abordaje
        END,
        hora_desembarque = CASE
            WHEN p_estado_destino IN ('EN_COLEGIO', 'ENTREGADO_ACUDIENTE') THEN v_ahora
            ELSE hora_desembarque
        END,
        actualizado_en = v_ahora
    WHERE public.viaje_estudiante.id_viaje = p_id_viaje
      AND public.viaje_estudiante.id_estudiante = p_id_estudiante;

    -- Inserción append-only en historial_estado_custodia:
    -- El trigger trg_encadenar_hash_custodia (V006) serializa con pg_advisory_xact_lock
    -- y encadena secuencia + hash_sha256_anterior + hash_sha256_actual.
    RETURN QUERY
    INSERT INTO public.historial_estado_custodia (
        id_estudiante,
        id_viaje,
        estado_origen,
        estado_destino,
        disparador_evento,
        coordenadas_gps,
        fecha_hora,
        registrado_por_usuario
    )
    VALUES (
        p_id_estudiante,
        p_id_viaje,
        v_estado_origen,
        p_estado_destino,
        COALESCE(NULLIF(TRIM(p_disparador_evento), ''), 'TRANSICION_FSM'),
        v_geog,
        v_ahora,
        p_registrado_por_usuario
    )
    RETURNING
        public.historial_estado_custodia.id_historial,
        public.historial_estado_custodia.secuencia,
        public.historial_estado_custodia.id_estudiante,
        public.historial_estado_custodia.id_viaje,
        public.historial_estado_custodia.estado_origen,
        public.historial_estado_custodia.estado_destino,
        public.historial_estado_custodia.disparador_evento,
        public.historial_estado_custodia.fecha_hora,
        public.historial_estado_custodia.registrado_por_usuario,
        public.historial_estado_custodia.hash_sha256_anterior,
        public.historial_estado_custodia.hash_sha256_actual;
END;
$$ LANGUAGE plpgsql;

-- 4. Función de inicialización diaria/matutina idempotente en viaje_estudiante
CREATE OR REPLACE FUNCTION public.fn_inicializar_custodia_matutina(
    p_fecha DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
    id_viaje UUID,
    id_estudiante UUID,
    estado_custodia VARCHAR(30)
) AS $$
#variable_conflict use_column
BEGIN
    RETURN QUERY
    WITH candidatos AS (
        SELECT DISTINCT v.id_viaje, ar.id_estudiante
        FROM public.viaje v
        JOIN public.ruta r
          ON r.id_ruta = v.id_ruta
         AND r.activa = TRUE
        JOIN public.asignacion_ruta ar
          ON ar.id_ruta = v.id_ruta
         AND ar.activa = TRUE
        JOIN public.estudiante e
          ON e.id_estudiante = ar.id_estudiante
         AND e.activo = TRUE
        WHERE v.fecha = p_fecha
          AND v.estado IN ('PROGRAMADO', 'EN_CURSO')
          AND (
              ar.ciclo_horario = 'AMBOS'
              OR (r.jornada = 'MANANA' AND ar.ciclo_horario = 'IDA')
              OR (r.jornada = 'TARDE' AND ar.ciclo_horario = 'RETORNO')
              OR r.jornada = 'COMPLETA'
          )
    ),
    insertados AS (
        INSERT INTO public.viaje_estudiante (id_viaje, id_estudiante, estado_custodia)
        SELECT c.id_viaje, c.id_estudiante, 'NO_INICIADO'
        FROM candidatos c
        ON CONFLICT ON CONSTRAINT viaje_estudiante_pkey DO NOTHING
        RETURNING public.viaje_estudiante.id_viaje,
                  public.viaje_estudiante.id_estudiante,
                  public.viaje_estudiante.estado_custodia
    )
    SELECT i.id_viaje, i.id_estudiante, i.estado_custodia
    FROM insertados i;
END;
$$ LANGUAGE plpgsql;

-- 5. Mitigación de riesgo (Issue #7): Bloqueo de cierre de viaje (FINALIZADO)
--    si existen estudiantes con estado A_BORDO_VEHICULO
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

DROP TRIGGER IF EXISTS trg_bloquear_cierre_viaje_con_menores_a_bordo ON public.viaje;
CREATE TRIGGER trg_bloquear_cierre_viaje_con_menores_a_bordo
BEFORE UPDATE OF estado ON public.viaje
FOR EACH ROW
WHEN (NEW.estado = 'FINALIZADO' AND OLD.estado IS DISTINCT FROM 'FINALIZADO')
EXECUTE FUNCTION public.fn_bloquear_cierre_viaje_con_menores_a_bordo();

-- 6. Privilegios mínimos sobre las funciones almacenadas (ASVS V1.14)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        GRANT EXECUTE ON FUNCTION public.fn_validar_transicion_custodia(VARCHAR, VARCHAR, VARCHAR) TO app_user;
        GRANT EXECUTE ON FUNCTION public.fn_registrar_transicion_custodia(UUID, UUID, VARCHAR, VARCHAR, VARCHAR, UUID, DOUBLE PRECISION, DOUBLE PRECISION) TO app_user;
        GRANT EXECUTE ON FUNCTION public.fn_inicializar_custodia_matutina(DATE) TO app_user;
        GRANT EXECUTE ON FUNCTION public.fn_verificar_integridad_custodia(INT) TO app_user;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user_operations') THEN
        GRANT EXECUTE ON FUNCTION public.fn_validar_transicion_custodia(VARCHAR, VARCHAR, VARCHAR) TO app_user_operations;
        GRANT EXECUTE ON FUNCTION public.fn_registrar_transicion_custodia(UUID, UUID, VARCHAR, VARCHAR, VARCHAR, UUID, DOUBLE PRECISION, DOUBLE PRECISION) TO app_user_operations;
        GRANT EXECUTE ON FUNCTION public.fn_inicializar_custodia_matutina(DATE) TO app_user_operations;
        GRANT EXECUTE ON FUNCTION public.fn_verificar_integridad_custodia(INT) TO app_user_operations;
    END IF;
END $$;

COMMIT;
