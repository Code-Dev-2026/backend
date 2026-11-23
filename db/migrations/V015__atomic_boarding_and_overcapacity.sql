-- ============================================================================
-- CAMINO SEGURO - BACKEND CORE DDL (POSTGRESQL 16 + POSTGIS 3.4)
-- Archivo: V015__atomic_boarding_and_overcapacity.sql
-- Issue #8: Control atómico de abordaje QR y prevención concurrente de sobrecupo
-- Requisitos SRS: RF-08, RN-02, RN-05, OWASP ASVS V11.1
-- Reversible mediante: db/migrations/undo/U015__atomic_boarding_and_overcapacity.sql
-- ============================================================================

BEGIN;

-- 1. Clave de idempotencia sobre registro_de_asistencia para mitigar reintentos
--    de red del dispositivo móvil de la monitora (Issue #8: Riesgos y Mitigaciones)
ALTER TABLE public.registro_de_asistencia
    ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(120);

CREATE UNIQUE INDEX IF NOT EXISTS uq_asistencia_idempotency_key
    ON public.registro_de_asistencia (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- 2. Función almacenada atómica de abordaje QR con bloqueo pesimista FOR UPDATE,
--    incremento condicional de aforo (total_a_bordo < capacidad_nominal),
--    rechazo de doble abordaje (RN-05), respuesta no fatal estructurada,
--    inserción automática de incidente, sincronización FSM WORM (Issue #7)
--    y encolamiento de notificación push para el acudiente titular.
CREATE OR REPLACE FUNCTION public.fn_registrar_abordaje_atomico(
    p_id_viaje UUID,
    p_id_estudiante UUID DEFAULT NULL,
    p_qr_token_hash VARCHAR(64) DEFAULT NULL,
    p_metodo_validacion VARCHAR(30) DEFAULT 'QR_INSTITUCIONAL',
    p_latitud DOUBLE PRECISION DEFAULT NULL,
    p_longitud DOUBLE PRECISION DEFAULT NULL,
    p_registrado_por_usuario UUID DEFAULT NULL,
    p_idempotency_key VARCHAR(120) DEFAULT NULL,
    p_sincronizado_offline BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
    aprobado BOOLEAN,
    codigo VARCHAR(40),
    mensaje TEXT,
    id_viaje UUID,
    id_ruta UUID,
    id_estudiante UUID,
    id_asistencia UUID,
    id_incidente UUID,
    id_acudiente_titular UUID,
    id_notificacion UUID,
    estado_custodia VARCHAR(30),
    metodo_validacion VARCHAR(30),
    total_a_bordo INT,
    capacidad_nominal INT,
    duplicado_por_idempotencia BOOLEAN,
    fecha_hora TIMESTAMPTZ
) AS $$
#variable_conflict use_column
DECLARE
    v_id_viaje_locked UUID;
    v_id_ruta UUID;
    v_estado_viaje VARCHAR(20);
    v_total_actual INT;
    v_nuevo_total INT;
    v_capacidad_nominal INT;
    v_jornada_ruta VARCHAR(20);
    v_tipo_recorrido VARCHAR(10);
    v_id_estudiante UUID;
    v_id_pasajero_ocasional UUID := NULL;
    v_es_ocasional BOOLEAN := FALSE;
    v_asignado_ruta BOOLEAN := FALSE;
    v_matriculado_viaje BOOLEAN := FALSE;
    v_metodo_final VARCHAR(30) := COALESCE(NULLIF(TRIM(p_metodo_validacion), ''), 'QR_INSTITUCIONAL');
    v_qr_hash VARCHAR(64) := NULLIF(LOWER(TRIM(p_qr_token_hash)), '');
    v_idempotency_key VARCHAR(120) := NULLIF(TRIM(p_idempotency_key), '');
    v_geog GEOGRAPHY(Point, 4326);
    v_ahora TIMESTAMPTZ := clock_timestamp();
    v_existing_asistencia_id UUID := NULL;
    v_duplicado_idempotencia BOOLEAN := FALSE;
    v_id_asistencia UUID := NULL;
    v_id_incidente UUID := NULL;
    v_estado_custodia_actual VARCHAR(30) := NULL;
    v_id_acudiente_titular UUID := NULL;
    v_id_tipo_notif UUID := NULL;
    v_plantilla_notif TEXT := NULL;
    v_id_notificacion UUID := NULL;
BEGIN
    -- 1. Validación estricta de parámetros de entrada
    IF v_metodo_final NOT IN ('QR_INSTITUCIONAL', 'QR_OCASIONAL_TEMPORAL', 'VERIFICACION_VISUAL_PARADA') THEN
        RAISE EXCEPTION 'METODO_VALIDACION_INVALIDO: Metodo % no soportado.', v_metodo_final
            USING ERRCODE = '22023';
    END IF;

    IF p_latitud IS NULL OR p_longitud IS NULL THEN
        RAISE EXCEPTION 'COORDENADAS_INVALIDAS: Latitud y longitud WGS84 son obligatorias para registrar el abordaje.'
            USING ERRCODE = '22023';
    END IF;

    IF p_latitud < -90 OR p_latitud > 90 OR p_longitud < -180 OR p_longitud > 180 THEN
        RAISE EXCEPTION 'COORDENADAS_INVALIDAS: Rango WGS84 excedido (lat %, lon %).', p_latitud, p_longitud
            USING ERRCODE = '22023';
    END IF;

    IF p_id_estudiante IS NULL AND v_qr_hash IS NULL THEN
        RAISE EXCEPTION 'QR_INVALIDO: Se requiere un token QR homologado o identificador validado del estudiante.'
            USING ERRCODE = '22023';
    END IF;

    v_geog := ST_SetSRID(ST_MakePoint(p_longitud, p_latitud), 4326)::geography;

    -- 2. Bloqueo pesimista FOR UPDATE a nivel de fila sobre public.viaje (OWASP ASVS V11.1)
    --    Serializa todas las transacciones concurrentes de abordaje sobre el mismo viaje.
    SELECT
        v.id_viaje,
        v.id_ruta,
        v.estado,
        v.total_a_bordo,
        veh.capacidad_nominal,
        r.jornada
    INTO
        v_id_viaje_locked,
        v_id_ruta,
        v_estado_viaje,
        v_total_actual,
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

    IF v_estado_viaje <> 'EN_CURSO' THEN
        RAISE EXCEPTION 'VIAJE_NO_EN_CURSO: El viaje % se encuentra en estado % y debe estar EN_CURSO.',
            p_id_viaje, v_estado_viaje
            USING ERRCODE = '23514';
    END IF;

    -- 3. Resolución y homologación del estudiante (QR estático institucional, ocasional o dinámico verificado)
    IF p_id_estudiante IS NOT NULL THEN
        SELECT e.id_estudiante
        INTO v_id_estudiante
        FROM public.estudiante e
        WHERE e.id_estudiante = p_id_estudiante
          AND e.activo = TRUE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'QR_INVALIDO: El estudiante % no existe o se encuentra inactivo.', p_id_estudiante
                USING ERRCODE = 'P0002';
        END IF;
    ELSE
        SELECT e.id_estudiante
        INTO v_id_estudiante
        FROM public.estudiante e
        WHERE LOWER(e.qr_token_hash) = v_qr_hash
          AND e.activo = TRUE;

        IF FOUND THEN
            v_metodo_final := 'QR_INSTITUCIONAL';
        ELSE
            SELECT po.id_estudiante, po.id_pasajero_ocasional
            INTO v_id_estudiante, v_id_pasajero_ocasional
            FROM public.pasajero_ocasional po
            JOIN public.estudiante e
              ON e.id_estudiante = po.id_estudiante
             AND e.activo = TRUE
            WHERE LOWER(po.qr_provisional_hash) = v_qr_hash
              AND po.id_viaje = p_id_viaje
              AND po.estado_solicitud IN ('APROBADO_COORDINACION', 'UTILIZADO');

            IF FOUND THEN
                v_metodo_final := 'QR_OCASIONAL_TEMPORAL';
                v_es_ocasional := TRUE;
            ELSE
                RAISE EXCEPTION 'QR_INVALIDO: El codigo QR no corresponde a un estudiante activo ni a un pase ocasional aprobado para este viaje.'
                    USING ERRCODE = 'P0002';
            END IF;
        END IF;
    END IF;

    -- 4. Verificación de asignación del estudiante a la ruta o autorización ocasional del viaje
    SELECT EXISTS (
        SELECT 1
        FROM public.asignacion_ruta ar
        WHERE ar.id_estudiante = v_id_estudiante
          AND ar.id_ruta = v_id_ruta
          AND ar.activa = TRUE
          AND (
              ar.ciclo_horario = 'AMBOS'
              OR (v_jornada_ruta = 'MANANA' AND ar.ciclo_horario = 'IDA')
              OR (v_jornada_ruta = 'TARDE' AND ar.ciclo_horario = 'RETORNO')
              OR v_jornada_ruta = 'COMPLETA'
          )
    ) INTO v_asignado_ruta;

    IF NOT v_asignado_ruta AND NOT v_es_ocasional THEN
        SELECT po.id_pasajero_ocasional
        INTO v_id_pasajero_ocasional
        FROM public.pasajero_ocasional po
        WHERE po.id_viaje = p_id_viaje
          AND po.id_estudiante = v_id_estudiante
          AND po.estado_solicitud IN ('APROBADO_COORDINACION', 'UTILIZADO')
        LIMIT 1;

        IF FOUND THEN
            v_es_ocasional := TRUE;
        END IF;
    END IF;

    IF NOT v_asignado_ruta AND NOT v_es_ocasional THEN
        SELECT EXISTS (
            SELECT 1
            FROM public.viaje_estudiante ve
            WHERE ve.id_viaje = p_id_viaje
              AND ve.id_estudiante = v_id_estudiante
        ) INTO v_matriculado_viaje;
    END IF;

    IF NOT v_asignado_ruta AND NOT v_es_ocasional AND NOT v_matriculado_viaje THEN
        RAISE EXCEPTION 'ESTUDIANTE_NO_ASIGNADO_RUTA: El estudiante % no esta asignado a la ruta % del viaje %.',
            v_id_estudiante, v_id_ruta, p_id_viaje
            USING ERRCODE = '23514';
    END IF;

    -- 5. Control de doble escaneo e idempotencia (RN-05)
    IF v_idempotency_key IS NOT NULL THEN
        SELECT ra.id_asistencia
        INTO v_existing_asistencia_id
        FROM public.registro_de_asistencia ra
        WHERE ra.idempotency_key = v_idempotency_key
        LIMIT 1;

        IF FOUND THEN
            v_duplicado_idempotencia := TRUE;
        END IF;
    END IF;

    IF v_existing_asistencia_id IS NULL THEN
        SELECT ra.id_asistencia
        INTO v_existing_asistencia_id
        FROM public.registro_de_asistencia ra
        WHERE ra.id_viaje = p_id_viaje
          AND ra.id_estudiante = v_id_estudiante
          AND ra.tipo_evento = 'ABORDAJE'
        LIMIT 1;
    END IF;

    IF v_existing_asistencia_id IS NOT NULL THEN
        INSERT INTO public.incidente (
            id_viaje,
            id_estudiante,
            tipo_incidente,
            severidad,
            descripcion,
            coordenada,
            fecha_hora,
            registrado_por_usuario
        )
        VALUES (
            p_id_viaje,
            v_id_estudiante,
            'DOBLE_ABORDAJE_DETECTADO',
            'ADVERTENCIA',
            CASE
                WHEN v_duplicado_idempotencia THEN
                    format('Reintento duplicado bloqueado por clave idempotente (%s) para estudiante %s en viaje %s (RN-05).',
                           v_idempotency_key, v_id_estudiante, p_id_viaje)
                ELSE
                    format('Doble abordaje rechazado (RN-05): el estudiante %s ya registra abordaje previo en el viaje %s.',
                           v_id_estudiante, p_id_viaje)
            END,
            v_geog,
            v_ahora,
            p_registrado_por_usuario
        )
        RETURNING public.incidente.id_incidente INTO v_id_incidente;

        SELECT ve.estado_custodia
        INTO v_estado_custodia_actual
        FROM public.viaje_estudiante ve
        WHERE ve.id_viaje = p_id_viaje
          AND ve.id_estudiante = v_id_estudiante;

        RETURN QUERY SELECT
            FALSE,
            'ABORDAJE_PREVIO_EXISTE'::VARCHAR(40),
            format('El estudiante %s ya registra abordaje previo en el viaje %s (RN-05).', v_id_estudiante, p_id_viaje),
            p_id_viaje,
            v_id_ruta,
            v_id_estudiante,
            v_existing_asistencia_id,
            v_id_incidente,
            NULL::UUID,
            NULL::UUID,
            COALESCE(v_estado_custodia_actual, 'A_BORDO_VEHICULO'::VARCHAR(30)),
            v_metodo_final,
            v_total_actual,
            v_capacidad_nominal,
            v_duplicado_idempotencia,
            v_ahora;
        RETURN;
    END IF;

    -- 6. Incremento atómico anti-sobrecupo a nivel de fila (RN-02 / OWASP ASVS V11.1)
    UPDATE public.viaje
    SET total_a_bordo = public.viaje.total_a_bordo + 1
    WHERE public.viaje.id_viaje = p_id_viaje
      AND public.viaje.estado = 'EN_CURSO'
      AND public.viaje.total_a_bordo < v_capacidad_nominal
    RETURNING public.viaje.total_a_bordo INTO v_nuevo_total;

    IF NOT FOUND THEN
        -- Vehículo en capacidad máxima: no se incrementa el contador, se inserta incidente CRITICO
        -- y se retorna código estructurado no fatal DENEGADO_SOBRECUPO.
        INSERT INTO public.incidente (
            id_viaje,
            id_estudiante,
            tipo_incidente,
            severidad,
            descripcion,
            coordenada,
            fecha_hora,
            registrado_por_usuario
        )
        VALUES (
            p_id_viaje,
            v_id_estudiante,
            'INTENTO_SOBRECUPO',
            'CRITICO',
            format(
                'Abordaje denegado por sobrecupo (RN-02): el vehiculo alcanzo su capacidad homologada (%s/%s pasajeros).',
                v_total_actual,
                v_capacidad_nominal
            ),
            v_geog,
            v_ahora,
            p_registrado_por_usuario
        )
        RETURNING public.incidente.id_incidente INTO v_id_incidente;

        SELECT ve.estado_custodia
        INTO v_estado_custodia_actual
        FROM public.viaje_estudiante ve
        WHERE ve.id_viaje = p_id_viaje
          AND ve.id_estudiante = v_id_estudiante;

        RETURN QUERY SELECT
            FALSE,
            'DENEGADO_SOBRECUPO'::VARCHAR(40),
            format('Abordaje denegado: el vehiculo alcanzo su capacidad maxima homologada (%s/%s pasajeros).',
                   v_total_actual, v_capacidad_nominal),
            p_id_viaje,
            v_id_ruta,
            v_id_estudiante,
            NULL::UUID,
            v_id_incidente,
            NULL::UUID,
            NULL::UUID,
            COALESCE(v_estado_custodia_actual, 'NO_INICIADO'::VARCHAR(30)),
            v_metodo_final,
            v_total_actual,
            v_capacidad_nominal,
            FALSE,
            v_ahora;
        RETURN;
    END IF;

    -- 7. Inserción transaccional en registro_de_asistencia (respaldada por UNIQUE(id_viaje, id_estudiante, tipo_evento))
    INSERT INTO public.registro_de_asistencia (
        id_viaje,
        id_estudiante,
        tipo_evento,
        metodo_validacion,
        coordenada,
        fecha_hora,
        sincronizado_offline,
        idempotency_key
    )
    VALUES (
        p_id_viaje,
        v_id_estudiante,
        'ABORDAJE',
        v_metodo_final,
        v_geog,
        v_ahora,
        COALESCE(p_sincronizado_offline, FALSE),
        v_idempotency_key
    )
    RETURNING public.registro_de_asistencia.id_asistencia INTO v_id_asistencia;

    IF v_id_pasajero_ocasional IS NOT NULL THEN
        UPDATE public.pasajero_ocasional
        SET estado_solicitud = 'UTILIZADO'
        WHERE id_pasajero_ocasional = v_id_pasajero_ocasional
          AND estado_solicitud = 'APROBADO_COORDINACION';
    END IF;

    -- 8. Sincronización con máquina de estados de custodia y ledger WORM SHA-256 (Issue #7)
    v_tipo_recorrido := CASE WHEN v_jornada_ruta = 'TARDE' THEN 'TARDE' ELSE 'MANANA' END;

    INSERT INTO public.viaje_estudiante (
        id_viaje,
        id_estudiante,
        estado_custodia,
        es_pasajero_ocasional
    )
    VALUES (
        p_id_viaje,
        v_id_estudiante,
        'NO_INICIADO',
        v_es_ocasional
    )
    ON CONFLICT ON CONSTRAINT viaje_estudiante_pkey DO NOTHING;

    SELECT ve.estado_custodia
    INTO v_estado_custodia_actual
    FROM public.viaje_estudiante ve
    WHERE ve.id_viaje = p_id_viaje
      AND ve.id_estudiante = v_id_estudiante
    FOR UPDATE;

    IF v_estado_custodia_actual = 'NO_INICIADO' THEN
        PERFORM * FROM public.fn_registrar_transicion_custodia(
            p_id_viaje,
            v_id_estudiante,
            'EN_ESPERA_ABORDAJE',
            v_tipo_recorrido,
            'LLEGADA_PARADA_ABORDAJE',
            p_registrado_por_usuario,
            p_latitud,
            p_longitud
        );
        v_estado_custodia_actual := 'EN_ESPERA_ABORDAJE';
    END IF;

    IF v_estado_custodia_actual <> 'A_BORDO_VEHICULO' THEN
        PERFORM * FROM public.fn_registrar_transicion_custodia(
            p_id_viaje,
            v_id_estudiante,
            'A_BORDO_VEHICULO',
            v_tipo_recorrido,
            'ABORDAJE_QR',
            p_registrado_por_usuario,
            p_latitud,
            p_longitud
        );
        v_estado_custodia_actual := 'A_BORDO_VEHICULO';
    END IF;

    -- 9. Encolamiento de notificación push hacia el acudiente titular del menor
    SELECT ea.id_acudiente
    INTO v_id_acudiente_titular
    FROM public.estudiante_acudiente ea
    WHERE ea.id_estudiante = v_id_estudiante
    ORDER BY ea.es_tutor_principal DESC, ea.orden_notificacion ASC
    LIMIT 1;

    IF v_id_acudiente_titular IS NOT NULL THEN
        SELECT tn.id_tipo, tn.plantilla_mensaje
        INTO v_id_tipo_notif, v_plantilla_notif
        FROM public.tipo_notificacion tn
        WHERE tn.codigo = 'ABORDAJE_EXITOSO'
        LIMIT 1;

        IF v_id_tipo_notif IS NOT NULL THEN
            INSERT INTO public.notificacion (
                id_tipo,
                id_estudiante,
                id_acudiente,
                id_viaje,
                canal,
                titulo,
                contenido_mensaje,
                payload_adicional,
                estado_envio,
                idempotency_key
            )
            VALUES (
                v_id_tipo_notif,
                v_id_estudiante,
                v_id_acudiente_titular,
                p_id_viaje,
                'PUSH',
                'Abordaje confirmado',
                COALESCE(v_plantilla_notif, 'El estudiante ha subido al vehiculo escolar.'),
                jsonb_build_object(
                    'id_viaje', p_id_viaje,
                    'id_asistencia', v_id_asistencia,
                    'total_a_bordo', v_nuevo_total,
                    'capacidad_nominal', v_capacidad_nominal,
                    'estado_custodia', v_estado_custodia_actual
                ),
                'PENDIENTE',
                'abordaje:' || p_id_viaje::text || ':' || v_id_estudiante::text
            )
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING public.notificacion.id_notificacion INTO v_id_notificacion;
        END IF;
    END IF;

    RETURN QUERY SELECT
        TRUE,
        'ABORDAJE_EXITOSO'::VARCHAR(40),
        format('Abordaje registrado exitosamente (%s/%s pasajeros a bordo).', v_nuevo_total, v_capacidad_nominal),
        p_id_viaje,
        v_id_ruta,
        v_id_estudiante,
        v_id_asistencia,
        NULL::UUID,
        v_id_acudiente_titular,
        v_id_notificacion,
        v_estado_custodia_actual,
        v_metodo_final,
        v_nuevo_total,
        v_capacidad_nominal,
        FALSE,
        v_ahora;
END;
$$ LANGUAGE plpgsql;

-- 3. Privilegios mínimos sobre la función almacenada y tablas operativas (ASVS V1.14)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        GRANT EXECUTE ON FUNCTION public.fn_registrar_abordaje_atomico(
            UUID, UUID, VARCHAR, VARCHAR, DOUBLE PRECISION, DOUBLE PRECISION, UUID, VARCHAR, BOOLEAN
        ) TO app_user;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user_operations') THEN
        GRANT EXECUTE ON FUNCTION public.fn_registrar_abordaje_atomico(
            UUID, UUID, VARCHAR, VARCHAR, DOUBLE PRECISION, DOUBLE PRECISION, UUID, VARCHAR, BOOLEAN
        ) TO app_user_operations;
        GRANT SELECT, INSERT ON public.notificacion TO app_user_operations;
        GRANT UPDATE ON public.pasajero_ocasional TO app_user_operations;
    END IF;
END $$;

COMMIT;
