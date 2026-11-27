-- ============================================================================
-- CAMINO SEGURO - BACKEND CORE DDL (POSTGRESQL 16 + POSTGIS 3.4)
-- Archivo: V018__occasional_passengers_and_seat_reallocation.sql
-- Issue #11: Gestión transaccional de pasajeros ocasionales y reasignación de cupos
-- Requisitos SRS: RF-05, RN-03, OWASP ASVS V4.1
-- Reversible mediante: db/migrations/undo/U018__occasional_passengers_and_seat_reallocation.sql
-- ============================================================================

BEGIN;

-- 1. Metadatos auditables de la solicitud en `public.pasajero_ocasional`
--    Columnas opcionales para total compatibilidad hacia atrás con V005 y V015.
ALTER TABLE public.pasajero_ocasional
    ADD COLUMN IF NOT EXISTS solicitado_por_acudiente UUID REFERENCES public.acudiente(id_acudiente) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS motivo TEXT;

-- 2. Invariante: un estudiante no puede ocupar el cupo liberado por sí mismo
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.pasajero_ocasional'::regclass
          AND conname = 'chk_pasajero_ocasional_distinto_liberador'
    ) THEN
        ALTER TABLE public.pasajero_ocasional
            ADD CONSTRAINT chk_pasajero_ocasional_distinto_liberador
            CHECK (id_estudiante <> id_estudiante_que_libera_cupo);
    END IF;
END $$;

-- 3. Restricción única parcial: un estudiante solo puede tener una solicitud activa
--    (RADICADA, APROBADO_COORDINACION o UTILIZADO) por viaje
CREATE UNIQUE INDEX IF NOT EXISTS uq_pasajero_ocasional_estudiante_viaje
    ON public.pasajero_ocasional (id_viaje, id_estudiante)
    WHERE (estado_solicitud IN ('RADICADA', 'APROBADO_COORDINACION', 'UTILIZADO'));

CREATE INDEX IF NOT EXISTS idx_pasajero_ocasional_acudiente
    ON public.pasajero_ocasional (solicitado_por_acudiente)
    WHERE solicitado_por_acudiente IS NOT NULL;

-- 4. Mitigación de riesgo (Issue #11): una inasistencia confirmada NO puede
--    revertirse ni eliminarse si el cupo ya fue legalmente asignado a un
--    pasajero ocasional activo (RADICADA, APROBADO_COORDINACION o UTILIZADO).
CREATE OR REPLACE FUNCTION public.fn_proteger_inasistencia_cupo_asignado()
RETURNS TRIGGER AS $$
DECLARE
    v_cupo_asignado BOOLEAN := FALSE;
BEGIN
    IF TG_OP = 'DELETE'
       OR (
           TG_OP = 'UPDATE' AND (
               NEW.cupo_liberado IS DISTINCT FROM TRUE
               OR NEW.id_viaje <> OLD.id_viaje
               OR NEW.id_estudiante <> OLD.id_estudiante
           )
       ) THEN
        SELECT EXISTS (
            SELECT 1
            FROM public.pasajero_ocasional po
            WHERE po.id_viaje = OLD.id_viaje
              AND po.id_estudiante_que_libera_cupo = OLD.id_estudiante
              AND po.estado_solicitud IN ('RADICADA', 'APROBADO_COORDINACION', 'UTILIZADO')
        ) INTO v_cupo_asignado;

        IF v_cupo_asignado THEN
            RAISE EXCEPTION 'INASISTENCIA_IRREVERSIBLE_CUPO_ASIGNADO: La inasistencia del estudiante % en el viaje % no puede revertirse porque el cupo fue asignado a un pasajero ocasional.',
                OLD.id_estudiante, OLD.id_viaje
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_proteger_inasistencia_cupo_asignado ON public.inasistencia;
CREATE TRIGGER trg_proteger_inasistencia_cupo_asignado
BEFORE UPDATE OR DELETE ON public.inasistencia
FOR EACH ROW EXECUTE FUNCTION public.fn_proteger_inasistencia_cupo_asignado();

-- 5. Función de evaluación del balance de vacantes netas del viaje (RF-05 / RN-03)
--    Fórmula:
--      ocupacion_base = GREATEST(0, estudiantes_asignados - inasistencias_reportadas)
--      ocupacion_proyectada = ocupacion_base + ocasionales_activos
--      cupo_nominal_disponible = GREATEST(0, capacidad_nominal - ocupacion_proyectada)
--      inasistencias_disponibles = GREATEST(0, inasistencias_reportadas - ocasionales_activos)
--      vacantes_netas = LEAST(cupo_nominal_disponible, inasistencias_disponibles)
CREATE OR REPLACE FUNCTION public.fn_evaluar_balance_vacantes_viaje(
    p_id_viaje UUID
)
RETURNS TABLE (
    id_viaje UUID,
    id_ruta UUID,
    estado_viaje VARCHAR(20),
    hora_inicio_programada TIMESTAMPTZ,
    capacidad_nominal INT,
    estudiantes_asignados INT,
    inasistencias_reportadas INT,
    ocasionales_activos INT,
    ocupacion_proyectada INT,
    inasistencias_disponibles INT,
    cupo_nominal_disponible INT,
    vacantes_netas INT
) AS $$
#variable_conflict use_column
DECLARE
    v_id_ruta UUID;
    v_estado_viaje VARCHAR(20);
    v_hora_inicio TIMESTAMPTZ;
    v_capacidad_nominal INT;
    v_jornada_ruta VARCHAR(20);
    v_asignados INT := 0;
    v_inasistencias INT := 0;
    v_ocasionales INT := 0;
    v_ocupacion_proyectada INT := 0;
    v_inasistencias_disp INT := 0;
    v_cupo_nominal_disp INT := 0;
    v_vacantes_netas INT := 0;
BEGIN
    SELECT
        v.id_ruta,
        v.estado,
        v.hora_inicio_programada,
        veh.capacidad_nominal,
        r.jornada
    INTO
        v_id_ruta,
        v_estado_viaje,
        v_hora_inicio,
        v_capacidad_nominal,
        v_jornada_ruta
    FROM public.viaje v
    JOIN public.vehiculo veh ON veh.id_vehiculo = v.id_vehiculo
    JOIN public.ruta r ON r.id_ruta = v.id_ruta
    WHERE v.id_viaje = p_id_viaje;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'VIAJE_NO_ENCONTRADO: El viaje % no existe.', p_id_viaje
            USING ERRCODE = 'P0002';
    END IF;

    SELECT COUNT(DISTINCT ar.id_estudiante)::INT
    INTO v_asignados
    FROM public.asignacion_ruta ar
    JOIN public.estudiante e
      ON e.id_estudiante = ar.id_estudiante
     AND e.activo = TRUE
    WHERE ar.id_ruta = v_id_ruta
      AND ar.activa = TRUE
      AND (
          ar.ciclo_horario = 'AMBOS'
          OR (v_jornada_ruta = 'MANANA' AND ar.ciclo_horario = 'IDA')
          OR (v_jornada_ruta = 'TARDE' AND ar.ciclo_horario = 'RETORNO')
          OR v_jornada_ruta = 'COMPLETA'
      );

    SELECT COUNT(*)::INT
    INTO v_inasistencias
    FROM public.inasistencia i
    WHERE i.id_viaje = p_id_viaje
      AND i.cupo_liberado = TRUE;

    SELECT COUNT(*)::INT
    INTO v_ocasionales
    FROM public.pasajero_ocasional po
    WHERE po.id_viaje = p_id_viaje
      AND po.estado_solicitud IN ('RADICADA', 'APROBADO_COORDINACION', 'UTILIZADO');

    v_ocupacion_proyectada := GREATEST(0, v_asignados - v_inasistencias) + v_ocasionales;
    v_inasistencias_disp := GREATEST(0, v_inasistencias - v_ocasionales);
    v_cupo_nominal_disp := GREATEST(0, v_capacidad_nominal - v_ocupacion_proyectada);
    v_vacantes_netas := LEAST(v_cupo_nominal_disp, v_inasistencias_disp);

    RETURN QUERY SELECT
        p_id_viaje,
        v_id_ruta,
        v_estado_viaje,
        v_hora_inicio,
        v_capacidad_nominal,
        v_asignados,
        v_inasistencias,
        v_ocasionales,
        v_ocupacion_proyectada,
        v_inasistencias_disp,
        v_cupo_nominal_disp,
        v_vacantes_netas;
END;
$$ LANGUAGE plpgsql STABLE;

-- 6. Función atómica de solicitud de pasajero ocasional (RF-05, RN-03, ASVS V4.1)
--    - Bloqueo pesimista FOR UPDATE sobre public.viaje (evita doble asignación concurrente).
--    - Verificación OWASP ASVS V4.1 acudiente-estudiante.
--    - Evaluación conjunta sin cortocircuito de antelación >= 2h y vacante por inasistencia.
--    - Selección atómica FOR UPDATE SKIP LOCKED de una inasistencia disponible.
CREATE OR REPLACE FUNCTION public.fn_solicitar_pasajero_ocasional(
    p_id_viaje UUID,
    p_id_estudiante UUID,
    p_solicitado_por_usuario UUID,
    p_qr_provisional_hash VARCHAR(64),
    p_motivo TEXT DEFAULT NULL,
    p_solicitado_en TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
    id_pasajero_ocasional UUID,
    id_estudiante UUID,
    id_viaje UUID,
    id_ruta UUID,
    id_estudiante_que_libera_cupo UUID,
    qr_provisional_hash VARCHAR(64),
    estado_solicitud VARCHAR(30),
    solicitado_en TIMESTAMPTZ,
    solicitado_por_acudiente UUID,
    motivo TEXT,
    hora_inicio_programada TIMESTAMPTZ,
    capacidad_nominal INT,
    estudiantes_asignados INT,
    inasistencias_reportadas INT,
    ocasionales_activos INT,
    ocupacion_proyectada INT,
    vacantes_netas_restantes INT
) AS $$
#variable_conflict use_column
DECLARE
    v_id_ruta UUID;
    v_estado_viaje VARCHAR(20);
    v_hora_inicio_prog TIMESTAMPTZ;
    v_capacidad_nominal INT;
    v_jornada_ruta VARCHAR(20);
    v_estudiante_activo BOOLEAN;
    v_id_acudiente UUID;
    v_ya_asignado_ruta BOOLEAN := FALSE;
    v_ya_solicitado BOOLEAN := FALSE;
    v_ahora TIMESTAMPTZ := COALESCE(p_solicitado_en, clock_timestamp());
    v_qr_hash VARCHAR(64) := NULLIF(LOWER(TRIM(p_qr_provisional_hash)), '');
    v_balance RECORD;
    v_id_liberador UUID := NULL;
    v_antelacion_ok BOOLEAN := FALSE;
    v_motivos TEXT[] := ARRAY[]::TEXT[];
    v_inserted RECORD;
BEGIN
    IF p_id_viaje IS NULL OR p_id_estudiante IS NULL OR p_solicitado_por_usuario IS NULL THEN
        RAISE EXCEPTION 'PARAMETROS_INVALIDOS: id_viaje, id_estudiante y usuario solicitante son obligatorios.'
            USING ERRCODE = '22023';
    END IF;

    IF v_qr_hash IS NULL OR v_qr_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION 'QR_PROVISIONAL_INVALIDO: El hash del QR provisional debe ser un SHA-256 hexadecimal de 64 caracteres.'
            USING ERRCODE = '22023';
    END IF;

    -- 1. Bloqueo pesimista a nivel de fila sobre public.viaje (serializa reservas concurrentes)
    SELECT
        v.id_ruta,
        v.estado,
        v.hora_inicio_programada,
        veh.capacidad_nominal,
        r.jornada
    INTO
        v_id_ruta,
        v_estado_viaje,
        v_hora_inicio_prog,
        v_capacidad_nominal,
        v_jornada_ruta
    FROM public.viaje v
    JOIN public.vehiculo veh ON veh.id_vehiculo = v.id_vehiculo
    JOIN public.ruta r ON r.id_ruta = v.id_ruta
    WHERE v.id_viaje = p_id_viaje
    FOR UPDATE OF v;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'VIAJE_NO_ENCONTRADO: El viaje % no existe.', p_id_viaje
            USING ERRCODE = 'P0002';
    END IF;

    IF v_estado_viaje <> 'PROGRAMADO' THEN
        RAISE EXCEPTION 'VIAJE_NO_PROGRAMADO: El viaje % se encuentra en estado % y solo se admiten solicitudes en estado PROGRAMADO.',
            p_id_viaje, v_estado_viaje
            USING ERRCODE = '23514';
    END IF;

    -- 2. Validar existencia del estudiante activo
    SELECT e.activo
    INTO v_estudiante_activo
    FROM public.estudiante e
    WHERE e.id_estudiante = p_id_estudiante;

    IF NOT FOUND OR v_estudiante_activo IS NOT TRUE THEN
        RAISE EXCEPTION 'ESTUDIANTE_NO_ENCONTRADO: El estudiante % no existe o se encuentra inactivo.', p_id_estudiante
            USING ERRCODE = 'P0002';
    END IF;

    -- 3. OWASP ASVS V4.1: Verificar vínculo acudiente-estudiante del usuario autenticado
    SELECT a.id_acudiente
    INTO v_id_acudiente
    FROM public.acudiente a
    JOIN public.estudiante_acudiente ea
      ON ea.id_acudiente = a.id_acudiente
     AND ea.id_estudiante = p_id_estudiante
    WHERE a.id_usuario = p_solicitado_por_usuario
    LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ACUDIENTE_NO_AUTORIZADO_PARA_ESTUDIANTE: El usuario % no es acudiente autorizado del estudiante % (OWASP ASVS V4.1).',
            p_solicitado_por_usuario, p_id_estudiante
            USING ERRCODE = '42501';
    END IF;

    -- 4. Verificar que el estudiante no esté ya asignado regularmente a esta ruta/jornada
    SELECT EXISTS (
        SELECT 1
        FROM public.asignacion_ruta ar
        WHERE ar.id_estudiante = p_id_estudiante
          AND ar.id_ruta = v_id_ruta
          AND ar.activa = TRUE
          AND (
              ar.ciclo_horario = 'AMBOS'
              OR (v_jornada_ruta = 'MANANA' AND ar.ciclo_horario = 'IDA')
              OR (v_jornada_ruta = 'TARDE' AND ar.ciclo_horario = 'RETORNO')
              OR v_jornada_ruta = 'COMPLETA'
          )
    ) INTO v_ya_asignado_ruta;

    IF v_ya_asignado_ruta THEN
        RAISE EXCEPTION 'ESTUDIANTE_YA_ASIGNADO_A_RUTA: El estudiante % ya tiene asignacion regular activa en la ruta %.',
            p_id_estudiante, v_id_ruta
            USING ERRCODE = '23505';
    END IF;

    -- 5. Verificar que no exista solicitud ocasional activa ni matrícula previa en el viaje
    SELECT EXISTS (
        SELECT 1
        FROM public.pasajero_ocasional po
        WHERE po.id_viaje = p_id_viaje
          AND po.id_estudiante = p_id_estudiante
          AND po.estado_solicitud IN ('RADICADA', 'APROBADO_COORDINACION', 'UTILIZADO')
    ) OR EXISTS (
        SELECT 1
        FROM public.viaje_estudiante ve
        WHERE ve.id_viaje = p_id_viaje
          AND ve.id_estudiante = p_id_estudiante
    ) INTO v_ya_solicitado;

    IF v_ya_solicitado THEN
        RAISE EXCEPTION 'SOLICITUD_DUPLICADA: El estudiante % ya tiene una solicitud activa o matricula en el viaje %.',
            p_id_estudiante, p_id_viaje
            USING ERRCODE = '23505';
    END IF;

    -- 6. Evaluar AMBAS reglas RN-03 sin cortocircuito (antelación >= 2h + vacante por inasistencia sin sobrecupo)
    v_antelacion_ok := (v_ahora <= (v_hora_inicio_prog - INTERVAL '2 hours'));

    SELECT *
    INTO v_balance
    FROM public.fn_evaluar_balance_vacantes_viaje(p_id_viaje);

    -- Selección atómica de una inasistencia con cupo liberado aún no asignada
    SELECT i.id_estudiante
    INTO v_id_liberador
    FROM public.inasistencia i
    WHERE i.id_viaje = p_id_viaje
      AND i.cupo_liberado = TRUE
      AND i.id_estudiante <> p_id_estudiante
      AND NOT EXISTS (
          SELECT 1
          FROM public.pasajero_ocasional po
          WHERE po.id_viaje = p_id_viaje
            AND po.id_estudiante_que_libera_cupo = i.id_estudiante
            AND po.estado_solicitud IN ('RADICADA', 'APROBADO_COORDINACION', 'UTILIZADO')
      )
    ORDER BY i.fecha_reporte ASC, i.id_inasistencia ASC
    FOR UPDATE OF i SKIP LOCKED
    LIMIT 1;

    IF NOT v_antelacion_ok THEN
        v_motivos := array_append(v_motivos, 'ANTELACION_INSUFICIENTE');
    END IF;

    IF v_id_liberador IS NULL OR v_balance.inasistencias_disponibles <= 0 THEN
        v_motivos := array_append(v_motivos, 'SIN_VACANTE_POR_INASISTENCIA');
    END IF;

    IF v_balance.ocupacion_proyectada >= v_capacidad_nominal THEN
        v_motivos := array_append(v_motivos, 'CAPACIDAD_NOMINAL_AGOTADA');
    END IF;

    IF array_length(v_motivos, 1) IS NOT NULL THEN
        RAISE EXCEPTION 'REGLAS_PASAJERO_OCASIONAL_INCUMPLIDAS[%]: Solicitud rechazada por incumplir RN-03 (motivos: %; asignados=%, inasistencias=%, ocasionales=%, capacidad=%).',
            array_to_string(v_motivos, ','),
            array_to_string(v_motivos, ', '),
            v_balance.estudiantes_asignados,
            v_balance.inasistencias_reportadas,
            v_balance.ocasionales_activos,
            v_capacidad_nominal
            USING ERRCODE = '23514';
    END IF;

    -- 7. Inserción atómica en pasajero_ocasional (protegida también por trg_validar_pasajero_ocasional y uq_pasajero_ocasional_cupo_liberado)
    INSERT INTO public.pasajero_ocasional (
        id_estudiante,
        id_viaje,
        id_estudiante_que_libera_cupo,
        qr_provisional_hash,
        estado_solicitud,
        solicitado_en,
        solicitado_por_acudiente,
        motivo
    )
    VALUES (
        p_id_estudiante,
        p_id_viaje,
        v_id_liberador,
        v_qr_hash,
        'RADICADA',
        v_ahora,
        v_id_acudiente,
        NULLIF(TRIM(p_motivo), '')
    )
    RETURNING
        public.pasajero_ocasional.id_pasajero_ocasional,
        public.pasajero_ocasional.id_estudiante,
        public.pasajero_ocasional.id_viaje,
        public.pasajero_ocasional.id_estudiante_que_libera_cupo,
        public.pasajero_ocasional.qr_provisional_hash,
        public.pasajero_ocasional.estado_solicitud,
        public.pasajero_ocasional.solicitado_en,
        public.pasajero_ocasional.solicitado_por_acudiente,
        public.pasajero_ocasional.motivo
    INTO v_inserted;

    SELECT *
    INTO v_balance
    FROM public.fn_evaluar_balance_vacantes_viaje(p_id_viaje);

    RETURN QUERY SELECT
        v_inserted.id_pasajero_ocasional,
        v_inserted.id_estudiante,
        v_inserted.id_viaje,
        v_id_ruta,
        v_inserted.id_estudiante_que_libera_cupo,
        v_inserted.qr_provisional_hash,
        v_inserted.estado_solicitud,
        v_inserted.solicitado_en,
        v_inserted.solicitado_por_acudiente,
        v_inserted.motivo,
        v_hora_inicio_prog,
        v_balance.capacidad_nominal,
        v_balance.estudiantes_asignados,
        v_balance.inasistencias_reportadas,
        v_balance.ocasionales_activos,
        v_balance.ocupacion_proyectada,
        v_balance.vacantes_netas;
END;
$$ LANGUAGE plpgsql;

-- 7. Función atómica de aprobación por Coordinación e inclusión automática en viaje_estudiante
--    Orden de bloqueos consistente (viaje -> pasajero_ocasional -> inasistencia -> viaje_estudiante)
--    para eliminar cualquier riesgo de deadlock con solicitudes o abordajes.
CREATE OR REPLACE FUNCTION public.fn_aprobar_pasajero_ocasional(
    p_id_pasajero_ocasional UUID,
    p_aprobado_por_usuario UUID,
    p_id_coordinador UUID DEFAULT NULL
)
RETURNS TABLE (
    id_pasajero_ocasional UUID,
    id_estudiante UUID,
    id_viaje UUID,
    id_ruta UUID,
    id_estudiante_que_libera_cupo UUID,
    qr_provisional_hash VARCHAR(64),
    estado_solicitud VARCHAR(30),
    solicitado_en TIMESTAMPTZ,
    aprobado_en TIMESTAMPTZ,
    aprobado_por_coordinador UUID,
    estado_custodia VARCHAR(30),
    es_pasajero_ocasional BOOLEAN,
    capacidad_nominal INT,
    estudiantes_asignados INT,
    inasistencias_reportadas INT,
    ocasionales_activos INT,
    ocupacion_proyectada INT,
    vacantes_netas_restantes INT
) AS $$
#variable_conflict use_column
DECLARE
    v_id_viaje UUID;
    v_id_ruta UUID;
    v_id_colegio_ruta UUID;
    v_estado_viaje VARCHAR(20);
    v_capacidad_nominal INT;
    v_req RECORD;
    v_id_coordinador UUID;
    v_id_colegio_coord UUID;
    v_inasistencia_activa BOOLEAN := FALSE;
    v_balance RECORD;
    v_ahora TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF p_id_pasajero_ocasional IS NULL OR p_aprobado_por_usuario IS NULL THEN
        RAISE EXCEPTION 'PARAMETROS_INVALIDOS: id_pasajero_ocasional y usuario coordinador son obligatorios.'
            USING ERRCODE = '22023';
    END IF;

    -- 1. Resolver id_viaje sin bloqueo previo para mantener orden canónico de locks (viaje primero)
    SELECT po.id_viaje
    INTO v_id_viaje
    FROM public.pasajero_ocasional po
    WHERE po.id_pasajero_ocasional = p_id_pasajero_ocasional;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'SOLICITUD_NO_ENCONTRADA: La solicitud de pasajero ocasional % no existe.', p_id_pasajero_ocasional
            USING ERRCODE = 'P0002';
    END IF;

    -- 2. Bloqueo pesimista sobre public.viaje
    SELECT
        v.id_ruta,
        r.id_colegio,
        v.estado,
        veh.capacidad_nominal
    INTO
        v_id_ruta,
        v_id_colegio_ruta,
        v_estado_viaje,
        v_capacidad_nominal
    FROM public.viaje v
    JOIN public.vehiculo veh ON veh.id_vehiculo = v.id_vehiculo
    JOIN public.ruta r ON r.id_ruta = v.id_ruta
    WHERE v.id_viaje = v_id_viaje
    FOR UPDATE OF v;

    -- 3. Bloqueo pesimista sobre public.pasajero_ocasional
    SELECT po.*
    INTO v_req
    FROM public.pasajero_ocasional po
    WHERE po.id_pasajero_ocasional = p_id_pasajero_ocasional
    FOR UPDATE;

    IF v_req.estado_solicitud <> 'RADICADA' THEN
        RAISE EXCEPTION 'SOLICITUD_ESTADO_INVALIDO: La solicitud % se encuentra en estado % y solo puede aprobarse desde RADICADA.',
            p_id_pasajero_ocasional, v_req.estado_solicitud
            USING ERRCODE = '23514';
    END IF;

    IF v_estado_viaje <> 'PROGRAMADO' THEN
        RAISE EXCEPTION 'VIAJE_NO_PROGRAMADO: El viaje % se encuentra en estado % y no admite aprobacion de pasajeros ocasionales.',
            v_id_viaje, v_estado_viaje
            USING ERRCODE = '23514';
    END IF;

    -- 4. Validar pertenencia del coordinador al colegio de la ruta (ASVS V4.1)
    IF p_id_coordinador IS NOT NULL THEN
        SELECT c.id_coordinador, c.id_colegio
        INTO v_id_coordinador, v_id_colegio_coord
        FROM public.coordinador c
        WHERE c.id_coordinador = p_id_coordinador
          AND c.id_usuario = p_aprobado_por_usuario;
    ELSE
        SELECT c.id_coordinador, c.id_colegio
        INTO v_id_coordinador, v_id_colegio_coord
        FROM public.coordinador c
        WHERE c.id_usuario = p_aprobado_por_usuario;
    END IF;

    IF NOT FOUND OR v_id_colegio_coord <> v_id_colegio_ruta THEN
        RAISE EXCEPTION 'COORDINADOR_NO_AUTORIZADO: El coordinador no esta acreditado para aprobar solicitudes en el colegio de la ruta %.',
            v_id_ruta
            USING ERRCODE = '42501';
    END IF;

    -- 5. Revalidar inasistencia liberadora y balance nominal (prohibición estricta de sobrecupo)
    SELECT EXISTS (
        SELECT 1
        FROM public.inasistencia i
        WHERE i.id_viaje = v_id_viaje
          AND i.id_estudiante = v_req.id_estudiante_que_libera_cupo
          AND i.cupo_liberado = TRUE
    ) INTO v_inasistencia_activa;

    IF NOT v_inasistencia_activa THEN
        RAISE EXCEPTION 'REGLAS_PASAJERO_OCASIONAL_INCUMPLIDAS[SIN_VACANTE_POR_INASISTENCIA]: La inasistencia asociada al cupo % ya no esta disponible.',
            v_req.id_estudiante_que_libera_cupo
            USING ERRCODE = '23514';
    END IF;

    SELECT *
    INTO v_balance
    FROM public.fn_evaluar_balance_vacantes_viaje(v_id_viaje);

    IF v_balance.ocupacion_proyectada > v_capacidad_nominal THEN
        RAISE EXCEPTION 'REGLAS_PASAJERO_OCASIONAL_INCUMPLIDAS[CAPACIDAD_NOMINAL_AGOTADA]: Aprobar la solicitud excederia la capacidad nominal del vehiculo (%/%).',
            v_balance.ocupacion_proyectada, v_capacidad_nominal
            USING ERRCODE = '23514';
    END IF;

    -- 6. Aprobar solicitud y registrar automáticamente en viaje_estudiante en la misma transacción
    UPDATE public.pasajero_ocasional
    SET estado_solicitud = 'APROBADO_COORDINACION',
        aprobado_en = v_ahora,
        aprobado_por_coordinador = v_id_coordinador
    WHERE public.pasajero_ocasional.id_pasajero_ocasional = p_id_pasajero_ocasional;

    IF EXISTS (
        SELECT 1
        FROM public.viaje_estudiante ve
        WHERE ve.id_viaje = v_id_viaje
          AND ve.id_estudiante = v_req.id_estudiante
    ) THEN
        RAISE EXCEPTION 'ESTUDIANTE_YA_EN_LISTA_VIAJE: El estudiante % ya figura en la lista de pasajeros del viaje %.',
            v_req.id_estudiante, v_id_viaje
            USING ERRCODE = '23505';
    END IF;

    INSERT INTO public.viaje_estudiante (
        id_viaje,
        id_estudiante,
        estado_custodia,
        es_pasajero_ocasional
    )
    VALUES (
        v_id_viaje,
        v_req.id_estudiante,
        'NO_INICIADO',
        TRUE
    );

    RETURN QUERY SELECT
        v_req.id_pasajero_ocasional,
        v_req.id_estudiante,
        v_id_viaje,
        v_id_ruta,
        v_req.id_estudiante_que_libera_cupo,
        v_req.qr_provisional_hash,
        'APROBADO_COORDINACION'::VARCHAR(30),
        v_req.solicitado_en,
        v_ahora,
        v_id_coordinador,
        'NO_INICIADO'::VARCHAR(30),
        TRUE,
        v_balance.capacidad_nominal,
        v_balance.estudiantes_asignados,
        v_balance.inasistencias_reportadas,
        v_balance.ocasionales_activos,
        v_balance.ocupacion_proyectada,
        v_balance.vacantes_netas;
END;
$$ LANGUAGE plpgsql;

-- 8. Privilegios mínimos sobre las funciones almacenadas (ASVS V1.14)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        GRANT EXECUTE ON FUNCTION public.fn_evaluar_balance_vacantes_viaje(UUID) TO app_user;
        GRANT EXECUTE ON FUNCTION public.fn_solicitar_pasajero_ocasional(
            UUID, UUID, UUID, VARCHAR, TEXT, TIMESTAMPTZ
        ) TO app_user;
        GRANT EXECUTE ON FUNCTION public.fn_aprobar_pasajero_ocasional(
            UUID, UUID, UUID
        ) TO app_user;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user_operations') THEN
        GRANT EXECUTE ON FUNCTION public.fn_evaluar_balance_vacantes_viaje(UUID) TO app_user_operations;
    END IF;
END $$;

COMMIT;
