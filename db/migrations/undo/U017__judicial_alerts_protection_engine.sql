-- ============================================================================
-- CAMINO SEGURO - REVERSIÓN DDL (UNDO MIGRATION)
-- Archivo: db/migrations/undo/U017__judicial_alerts_protection_engine.sql
-- Revierte completamente V017__judicial_alerts_protection_engine.sql (Issue #10)
-- Restaura exactamente fn_registrar_descenso_atomico de V016.
-- ============================================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_bloquear_entrega_por_alerta_judicial ON public.entrega;

DROP FUNCTION IF EXISTS public.fn_bloquear_entrega_por_alerta_judicial();

DROP FUNCTION IF EXISTS public.fn_registrar_incidente_alerta_judicial(
    UUID, UUID, UUID, VARCHAR, VARCHAR, VARCHAR, DOUBLE PRECISION, DOUBLE PRECISION, UUID, TEXT
);

-- Restaurar la definición exacta de V016 para fn_registrar_descenso_atomico
CREATE OR REPLACE FUNCTION public.fn_registrar_descenso_atomico(
    p_id_viaje UUID,
    p_id_estudiante UUID,
    p_resultado_entrega VARCHAR(30) DEFAULT 'ENTREGADO_EXITOSO',
    p_tipo_receptor VARCHAR(30) DEFAULT NULL,
    p_receptor_documento_blind_index VARCHAR(64) DEFAULT NULL,
    p_id_receptor UUID DEFAULT NULL,
    p_metodo_validacion VARCHAR(30) DEFAULT 'VERIFICACION_VISUAL_PARADA',
    p_latitud DOUBLE PRECISION DEFAULT NULL,
    p_longitud DOUBLE PRECISION DEFAULT NULL,
    p_registrado_por_usuario UUID DEFAULT NULL,
    p_foto_evidencia_url TEXT DEFAULT NULL,
    p_observaciones_fallido TEXT DEFAULT NULL,
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
    id_entrega UUID,
    id_asistencia UUID,
    id_incidente UUID,
    tipo_receptor VARCHAR(30),
    id_acudiente_receptor UUID,
    id_autorizado_receptor UUID,
    estado_entrega VARCHAR(30),
    estado_custodia VARCHAR(30),
    metodo_validacion VARCHAR(30),
    total_a_bordo INT,
    capacidad_nominal INT,
    id_acudientes_notificados UUID[],
    id_notificacion_principal UUID,
    duplicado_por_idempotencia BOOLEAN,
    fecha_hora TIMESTAMPTZ
) AS $$
#variable_conflict use_column
DECLARE
    v_id_ruta UUID;
    v_estado_viaje VARCHAR(20);
    v_total_actual INT;
    v_nuevo_total INT;
    v_capacidad_nominal INT;
    v_jornada_ruta VARCHAR(20);
    v_tipo_recorrido VARCHAR(10);
    v_estudiante_activo BOOLEAN;
    v_estado_custodia_actual VARCHAR(30);
    v_estado_custodia_destino VARCHAR(30);
    v_resultado_final VARCHAR(30) := UPPER(COALESCE(NULLIF(TRIM(p_resultado_entrega), ''), 'ENTREGADO_EXITOSO'));
    v_tipo_receptor_final VARCHAR(30) := UPPER(NULLIF(TRIM(p_tipo_receptor), ''));
    v_blind_index VARCHAR(64) := NULLIF(LOWER(TRIM(p_receptor_documento_blind_index)), '');
    v_metodo_final VARCHAR(30) := COALESCE(NULLIF(TRIM(p_metodo_validacion), ''), 'VERIFICACION_VISUAL_PARADA');
    v_idempotency_key VARCHAR(120) := NULLIF(TRIM(p_idempotency_key), '');
    v_geog GEOGRAPHY(Point, 4326);
    v_ahora TIMESTAMPTZ := clock_timestamp();
    v_intento_secuencia INT;
    v_id_entrega UUID := NULL;
    v_id_asistencia UUID := NULL;
    v_id_incidente UUID := NULL;
    v_id_acudiente_receptor UUID := NULL;
    v_id_autorizado_receptor UUID := NULL;
    v_autorizado_activo BOOLEAN;
    v_adulto_activo BOOLEAN;
    v_autorizado_hasta TIMESTAMPTZ;
    v_expediente_revocado BOOLEAN;
    v_total_autorizados_activos INT;
    v_alerta_judicial_radicado VARCHAR(50);
    v_acudiente_ids UUID[] := ARRAY[]::UUID[];
    v_acudiente_id UUID;
    v_id_tipo_notif UUID := NULL;
    v_plantilla_notif TEXT := NULL;
    v_canal_notif VARCHAR(20) := 'PUSH';
    v_id_notif_tmp UUID := NULL;
    v_id_notif_principal UUID := NULL;
    v_existing_entrega RECORD;
    v_existing_asistencia_id UUID := NULL;
BEGIN
    IF v_resultado_final NOT IN ('ENTREGADO_EXITOSO', 'DESEMBARQUE_FALLIDO_RETORNO') THEN
        RAISE EXCEPTION 'RESULTADO_ENTREGA_INVALIDO: Resultado % no soportado.', v_resultado_final
            USING ERRCODE = '22023';
    END IF;

    IF v_metodo_final NOT IN ('QR_INSTITUCIONAL', 'QR_OCASIONAL_TEMPORAL', 'VERIFICACION_VISUAL_PARADA') THEN
        RAISE EXCEPTION 'METODO_VALIDACION_INVALIDO: Metodo % no soportado.', v_metodo_final
            USING ERRCODE = '22023';
    END IF;

    IF p_latitud IS NULL OR p_longitud IS NULL THEN
        RAISE EXCEPTION 'COORDENADAS_INVALIDAS: Latitud y longitud WGS84 son obligatorias para registrar el descenso.'
            USING ERRCODE = '22023';
    END IF;

    IF p_latitud < -90 OR p_latitud > 90 OR p_longitud < -180 OR p_longitud > 180 THEN
        RAISE EXCEPTION 'COORDENADAS_INVALIDAS: Rango WGS84 excedido (lat %, lon %).', p_latitud, p_longitud
            USING ERRCODE = '22023';
    END IF;

    v_geog := ST_SetSRID(ST_MakePoint(p_longitud, p_latitud), 4326)::geography;

    SELECT
        v.id_ruta,
        v.estado,
        v.total_a_bordo,
        veh.capacidad_nominal,
        r.jornada
    INTO
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

    SELECT e.activo
    INTO v_estudiante_activo
    FROM public.estudiante e
    WHERE e.id_estudiante = p_id_estudiante;

    IF NOT FOUND OR v_estudiante_activo IS NOT TRUE THEN
        RAISE EXCEPTION 'ESTUDIANTE_NO_ENCONTRADO: El estudiante % no existe o esta inactivo.', p_id_estudiante
            USING ERRCODE = 'P0002';
    END IF;

    IF v_idempotency_key IS NOT NULL THEN
        SELECT ent.*
        INTO v_existing_entrega
        FROM public.entrega ent
        WHERE ent.idempotency_key = v_idempotency_key
        LIMIT 1;

        IF FOUND THEN
            SELECT ra.id_asistencia
            INTO v_existing_asistencia_id
            FROM public.registro_de_asistencia ra
            WHERE ra.id_viaje = v_existing_entrega.id_viaje
              AND ra.id_estudiante = v_existing_entrega.id_estudiante
              AND ra.tipo_evento = 'DESCENSO'
            LIMIT 1;

            SELECT ve.estado_custodia
            INTO v_estado_custodia_actual
            FROM public.viaje_estudiante ve
            WHERE ve.id_viaje = v_existing_entrega.id_viaje
              AND ve.id_estudiante = v_existing_entrega.id_estudiante;

            RETURN QUERY SELECT
                v_existing_entrega.estado_entrega = 'ENTREGADO_EXITOSO',
                CASE
                    WHEN v_existing_entrega.estado_entrega = 'ENTREGADO_EXITOSO' THEN 'DESCENSO_EXITOSO'::VARCHAR(40)
                    ELSE 'DESEMBARQUE_FALLIDO_RETORNO'::VARCHAR(40)
                END,
                'Solicitud procesada previamente por clave idempotente; sin cambios adicionales en aforo ni custodia.'::TEXT,
                v_existing_entrega.id_viaje,
                v_id_ruta,
                v_existing_entrega.id_estudiante,
                v_existing_entrega.id_entrega,
                v_existing_asistencia_id,
                NULL::UUID,
                v_existing_entrega.tipo_receptor,
                v_existing_entrega.id_acudiente,
                v_existing_entrega.id_autorizado,
                v_existing_entrega.estado_entrega,
                COALESCE(v_estado_custodia_actual, 'A_BORDO_VEHICULO'::VARCHAR(30)),
                v_metodo_final,
                v_total_actual,
                v_capacidad_nominal,
                ARRAY[]::UUID[],
                NULL::UUID,
                TRUE,
                v_existing_entrega.fecha_hora;
            RETURN;
        END IF;
    END IF;

    SELECT ve.estado_custodia
    INTO v_estado_custodia_actual
    FROM public.viaje_estudiante ve
    WHERE ve.id_viaje = p_id_viaje
      AND ve.id_estudiante = p_id_estudiante
    FOR UPDATE;

    IF NOT FOUND OR v_estado_custodia_actual <> 'A_BORDO_VEHICULO' THEN
        RAISE EXCEPTION 'ESTUDIANTE_NO_A_BORDO: El estudiante % no se encuentra A_BORDO_VEHICULO en el viaje % (estado actual: %).',
            p_id_estudiante, p_id_viaje, COALESCE(v_estado_custodia_actual, 'NO_MATRICULADO')
            USING ERRCODE = '23514';
    END IF;

    v_tipo_recorrido := CASE WHEN v_jornada_ruta = 'TARDE' THEN 'TARDE' ELSE 'MANANA' END;

    SELECT COALESCE(ARRAY_AGG(ea.id_acudiente ORDER BY ea.es_tutor_principal DESC, ea.orden_notificacion ASC), ARRAY[]::UUID[])
    INTO v_acudiente_ids
    FROM public.estudiante_acudiente ea
    WHERE ea.id_estudiante = p_id_estudiante;

    SELECT COALESCE(MAX(ent.intento_secuencia), 0) + 1
    INTO v_intento_secuencia
    FROM public.entrega ent
    WHERE ent.id_viaje = p_id_viaje
      AND ent.id_estudiante = p_id_estudiante;

    IF v_resultado_final = 'DESEMBARQUE_FALLIDO_RETORNO' THEN
        IF v_tipo_recorrido <> 'TARDE' THEN
            RAISE EXCEPTION 'RECORRIDO_INCOMPATIBLE_DESCENSO: El protocolo DESEMBARQUE_FALLIDO_RETORNO solo aplica en recorridos de TARDE.'
                USING ERRCODE = '23514';
        END IF;

        v_nuevo_total := v_total_actual;

        INSERT INTO public.entrega (
            id_viaje, id_estudiante, intento_secuencia, tipo_receptor, id_acudiente, id_autorizado,
            estado_entrega, foto_evidencia_url, coordenada, observaciones_fallido, fecha_hora, idempotency_key
        )
        VALUES (
            p_id_viaje, p_id_estudiante, v_intento_secuencia, 'RETORNO_SEDE_ESCOLAR', NULL, NULL,
            'DESEMBARQUE_FALLIDO_RETORNO', p_foto_evidencia_url, v_geog,
            COALESCE(NULLIF(TRIM(p_observaciones_fallido), ''), 'Ningun adulto autorizado comparecio en la parada; se activa retorno seguro a sede escolar.'),
            v_ahora, v_idempotency_key
        )
        RETURNING public.entrega.id_entrega INTO v_id_entrega;

        PERFORM * FROM public.fn_registrar_transicion_custodia(
            p_id_viaje, p_id_estudiante, 'RETORNO_SEDE_POR_FALLA_ENTREGA', 'TARDE',
            'DESEMBARQUE_FALLIDO_RETORNO', p_registrado_por_usuario, p_latitud, p_longitud
        );

        INSERT INTO public.incidente (
            id_viaje, id_estudiante, tipo_incidente, severidad, descripcion, coordenada, fecha_hora, registrado_por_usuario
        )
        VALUES (
            p_id_viaje, p_id_estudiante, 'DESEMBARQUE_FALLIDO_RETORNO', 'CRITICO',
            COALESCE(
                NULLIF(TRIM(p_observaciones_fallido), ''),
                format('Protocolo RF-11 activado: no comparecio receptor acreditado para el estudiante %s en viaje %s. Menor permanece a bordo rumbo a sede escolar.', p_id_estudiante, p_id_viaje)
            ),
            v_geog, v_ahora, p_registrado_por_usuario
        )
        RETURNING public.incidente.id_incidente INTO v_id_incidente;

        SELECT tn.id_tipo, tn.plantilla_mensaje, tn.canal_default
        INTO v_id_tipo_notif, v_plantilla_notif, v_canal_notif
        FROM public.tipo_notificacion tn
        WHERE tn.codigo = 'INCIDENTE_ENTREGA'
        LIMIT 1;

        IF v_id_tipo_notif IS NOT NULL AND array_length(v_acudiente_ids, 1) IS NOT NULL THEN
            FOREACH v_acudiente_id IN ARRAY v_acudiente_ids LOOP
                INSERT INTO public.notificacion (
                    id_tipo, id_estudiante, id_acudiente, id_viaje, canal, titulo,
                    contenido_mensaje, payload_adicional, silenciable, estado_envio, idempotency_key
                )
                VALUES (
                    v_id_tipo_notif, p_id_estudiante, v_acudiente_id, p_id_viaje, COALESCE(v_canal_notif, 'SMS'),
                    'Alerta crítica: retorno seguro a sede escolar',
                    COALESCE(v_plantilla_notif, 'No se pudo entregar al menor en parada; permanece a bordo rumbo a la sede escolar.'),
                    jsonb_build_object(
                        'id_viaje', p_id_viaje,
                        'id_entrega', v_id_entrega,
                        'id_incidente', v_id_incidente,
                        'estado_custodia', 'RETORNO_SEDE_POR_FALLA_ENTREGA',
                        'total_a_bordo', v_nuevo_total
                    ),
                    FALSE, 'PENDIENTE',
                    'fallo_entrega:' || v_id_entrega::text || ':' || v_acudiente_id::text
                )
                ON CONFLICT (idempotency_key) DO NOTHING
                RETURNING public.notificacion.id_notificacion INTO v_id_notif_tmp;

                IF v_id_notif_principal IS NULL AND v_id_notif_tmp IS NOT NULL THEN
                    v_id_notif_principal := v_id_notif_tmp;
                END IF;
            END LOOP;
        END IF;

        RETURN QUERY SELECT
            FALSE, 'DESEMBARQUE_FALLIDO_RETORNO'::VARCHAR(40),
            format('Protocolo de retorno seguro a sede activado: el estudiante %s permanece a bordo (%s/%s).',
                   p_id_estudiante, v_nuevo_total, v_capacidad_nominal),
            p_id_viaje, v_id_ruta, p_id_estudiante, v_id_entrega, NULL::UUID, v_id_incidente,
            'RETORNO_SEDE_ESCOLAR'::VARCHAR(30), NULL::UUID, NULL::UUID,
            'DESEMBARQUE_FALLIDO_RETORNO'::VARCHAR(30), 'RETORNO_SEDE_POR_FALLA_ENTREGA'::VARCHAR(30),
            v_metodo_final, v_nuevo_total, v_capacidad_nominal, v_acudiente_ids, v_id_notif_principal, FALSE, v_ahora;
        RETURN;
    END IF;

    IF v_tipo_receptor_final IS NULL OR v_tipo_receptor_final NOT IN ('ACUDIENTE', 'ADULTO_AUTORIZADO', 'SEDE_EDUCATIVA') THEN
        RAISE EXCEPTION 'TIPO_RECEPTOR_INVALIDO: Tipo de receptor % no soportado para entrega exitosa.', COALESCE(v_tipo_receptor_final, 'NULL')
            USING ERRCODE = '22023';
    END IF;

    IF v_tipo_receptor_final = 'SEDE_EDUCATIVA' THEN
        IF v_tipo_recorrido <> 'MANANA' THEN
            RAISE EXCEPTION 'RECORRIDO_INCOMPATIBLE_DESCENSO: La entrega directa a SEDE_EDUCATIVA solo aplica en recorrido MANANA; para retorno en TARDE utilice /asistencia/custodia/finalizar-sede.'
                USING ERRCODE = '23514';
        END IF;
        v_estado_custodia_destino := 'EN_COLEGIO';
    ELSE
        IF v_tipo_recorrido <> 'TARDE' THEN
            RAISE EXCEPTION 'RECORRIDO_INCOMPATIBLE_DESCENSO: La entrega a % solo aplica en recorrido TARDE.', v_tipo_receptor_final
                USING ERRCODE = '23514';
        END IF;

        IF v_blind_index IS NULL THEN
            RAISE EXCEPTION 'RECEPTOR_NO_AUTORIZADO: El blind index del documento del receptor es obligatorio para entrega a %.', v_tipo_receptor_final
                USING ERRCODE = '42501';
        END IF;

        SELECT aj.radicado_medida
        INTO v_alerta_judicial_radicado
        FROM public.alerta_judicial aj
        WHERE aj.id_estudiante = p_id_estudiante
          AND LOWER(aj.individuo_blind_index) = v_blind_index
          AND aj.activa = TRUE
          AND aj.eliminado_soft = FALSE
        LIMIT 1;

        IF FOUND THEN
            RAISE EXCEPTION 'ALERTA_JUDICIAL_ACTIVA: Prohibida la entrega del menor %; existe medida cautelar judicial activa (radicado %).',
                p_id_estudiante, v_alerta_judicial_radicado
                USING ERRCODE = '42501';
        END IF;

        IF v_tipo_receptor_final = 'ACUDIENTE' THEN
            SELECT a.id_acudiente
            INTO v_id_acudiente_receptor
            FROM public.acudiente a
            JOIN public.estudiante_acudiente ea
              ON ea.id_acudiente = a.id_acudiente
             AND ea.id_estudiante = p_id_estudiante
            WHERE LOWER(a.documento_blind_index) = v_blind_index
              AND (p_id_receptor IS NULL OR a.id_acudiente = p_id_receptor)
            LIMIT 1;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'RECEPTOR_NO_AUTORIZADO: El acudiente no esta acreditado para retirar al estudiante %.', p_id_estudiante
                    USING ERRCODE = '42501';
            END IF;
        ELSE
            SELECT COUNT(*)
            INTO v_total_autorizados_activos
            FROM public.estudiante_autorizado ea
            WHERE ea.id_estudiante = p_id_estudiante
              AND ea.activo = TRUE
              AND (ea.autorizado_hasta IS NULL OR ea.autorizado_hasta > v_ahora);

            IF v_total_autorizados_activos > 3 THEN
                RAISE EXCEPTION 'LIMITE_AUTORIZADOS_EXCEDIDO: Inconsistencia RN-04 detectada (% autorizados activos > 3) para el estudiante %.',
                    v_total_autorizados_activos, p_id_estudiante
                    USING ERRCODE = '23514';
            END IF;

            SELECT
                aa.id_autorizado, aa.activo, ea.activo, ea.autorizado_hasta, COALESCE(ec.revocado, FALSE)
            INTO
                v_id_autorizado_receptor, v_adulto_activo, v_autorizado_activo, v_autorizado_hasta, v_expediente_revocado
            FROM public.adulto_autorizado aa
            JOIN public.estudiante_autorizado ea
              ON ea.id_autorizado = aa.id_autorizado
             AND ea.id_estudiante = p_id_estudiante
            LEFT JOIN public.expediente_cifrado ec
              ON ec.id_autorizado = aa.id_autorizado
            WHERE LOWER(aa.documento_blind_index) = v_blind_index
              AND (p_id_receptor IS NULL OR aa.id_autorizado = p_id_receptor)
            LIMIT 1;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'RECEPTOR_NO_AUTORIZADO: El adulto no figura como autorizado vigente para el estudiante %.', p_id_estudiante
                    USING ERRCODE = '42501';
            END IF;

            IF v_adulto_activo IS NOT TRUE OR v_autorizado_activo IS NOT TRUE OR v_expediente_revocado IS TRUE THEN
                RAISE EXCEPTION 'RECEPTOR_INACTIVO_O_REVOCADO: La autorizacion del adulto receptor para el estudiante % esta inactiva o revocada.', p_id_estudiante
                    USING ERRCODE = '42501';
            END IF;

            IF v_autorizado_hasta IS NOT NULL AND v_autorizado_hasta <= v_ahora THEN
                RAISE EXCEPTION 'AUTORIZACION_VENCIDA: La autorizacion del receptor para el estudiante % vencio el %.',
                    p_id_estudiante, v_autorizado_hasta
                    USING ERRCODE = '42501';
            END IF;
        END IF;

        v_estado_custodia_destino := 'ENTREGADO_ACUDIENTE';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.registro_de_asistencia ra
        WHERE ra.id_viaje = p_id_viaje
          AND ra.id_estudiante = p_id_estudiante
          AND ra.tipo_evento = 'DESCENSO'
    ) THEN
        RAISE EXCEPTION 'DESCENSO_PREVIO_EXISTE: El estudiante % ya registra descenso en el viaje %.', p_id_estudiante, p_id_viaje
            USING ERRCODE = '23505';
    END IF;

    UPDATE public.viaje
    SET total_a_bordo = public.viaje.total_a_bordo - 1
    WHERE public.viaje.id_viaje = p_id_viaje
      AND public.viaje.estado = 'EN_CURSO'
      AND public.viaje.total_a_bordo > 0
    RETURNING public.viaje.total_a_bordo INTO v_nuevo_total;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'AFORO_INCONSISTENTE: No es posible decrementar total_a_bordo en viaje % porque el contador actual es %.',
            p_id_viaje, v_total_actual
            USING ERRCODE = '23514';
    END IF;

    INSERT INTO public.registro_de_asistencia (
        id_viaje, id_estudiante, tipo_evento, metodo_validacion, coordenada, fecha_hora, sincronizado_offline, idempotency_key
    )
    VALUES (
        p_id_viaje, p_id_estudiante, 'DESCENSO', v_metodo_final, v_geog, v_ahora, COALESCE(p_sincronizado_offline, FALSE), v_idempotency_key
    )
    RETURNING public.registro_de_asistencia.id_asistencia INTO v_id_asistencia;

    INSERT INTO public.entrega (
        id_viaje, id_estudiante, intento_secuencia, tipo_receptor, id_acudiente, id_autorizado,
        estado_entrega, foto_evidencia_url, coordenada, observaciones_fallido, fecha_hora, idempotency_key
    )
    VALUES (
        p_id_viaje, p_id_estudiante, v_intento_secuencia, v_tipo_receptor_final, v_id_acudiente_receptor, v_id_autorizado_receptor,
        'ENTREGADO_EXITOSO', p_foto_evidencia_url, v_geog, NULL, v_ahora, v_idempotency_key
    )
    RETURNING public.entrega.id_entrega INTO v_id_entrega;

    PERFORM * FROM public.fn_registrar_transicion_custodia(
        p_id_viaje, p_id_estudiante, v_estado_custodia_destino, v_tipo_recorrido,
        CASE
            WHEN v_tipo_receptor_final = 'SEDE_EDUCATIVA' THEN 'DESEMBARQUE_SEDE_EDUCATIVA'
            WHEN v_tipo_receptor_final = 'ACUDIENTE' THEN 'ENTREGA_ACUDIENTE'
            ELSE 'ENTREGA_ADULTO_AUTORIZADO'
        END,
        p_registrado_por_usuario, p_latitud, p_longitud
    );

    SELECT tn.id_tipo, tn.plantilla_mensaje
    INTO v_id_tipo_notif, v_plantilla_notif
    FROM public.tipo_notificacion tn
    WHERE tn.codigo = 'DESCENSO_EXITOSO'
    LIMIT 1;

    IF v_id_tipo_notif IS NOT NULL AND array_length(v_acudiente_ids, 1) IS NOT NULL THEN
        FOREACH v_acudiente_id IN ARRAY v_acudiente_ids LOOP
            INSERT INTO public.notificacion (
                id_tipo, id_estudiante, id_acudiente, id_viaje, canal, titulo,
                contenido_mensaje, payload_adicional, estado_envio, idempotency_key
            )
            VALUES (
                v_id_tipo_notif, p_id_estudiante, v_acudiente_id, p_id_viaje, 'PUSH',
                'Descenso y entrega confirmados',
                COALESCE(v_plantilla_notif, 'El estudiante ha sido entregado exitosamente.'),
                jsonb_build_object(
                    'id_viaje', p_id_viaje,
                    'id_entrega', v_id_entrega,
                    'id_asistencia', v_id_asistencia,
                    'tipo_receptor', v_tipo_receptor_final,
                    'estado_custodia', v_estado_custodia_destino,
                    'total_a_bordo', v_nuevo_total
                ),
                'PENDIENTE',
                'descenso:' || v_id_entrega::text || ':' || v_acudiente_id::text
            )
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING public.notificacion.id_notificacion INTO v_id_notif_tmp;

            IF v_id_notif_principal IS NULL AND v_id_notif_tmp IS NOT NULL THEN
                v_id_notif_principal := v_id_notif_tmp;
            END IF;
        END LOOP;
    END IF;

    RETURN QUERY SELECT
        TRUE, 'DESCENSO_EXITOSO'::VARCHAR(40),
        format('Descenso y entrega registrados exitosamente (%s/%s pasajeros a bordo).',
               v_nuevo_total, v_capacidad_nominal),
        p_id_viaje, v_id_ruta, p_id_estudiante, v_id_entrega, v_id_asistencia, NULL::UUID,
        v_tipo_receptor_final, v_id_acudiente_receptor, v_id_autorizado_receptor,
        'ENTREGADO_EXITOSO'::VARCHAR(30), v_estado_custodia_destino, v_metodo_final,
        v_nuevo_total, v_capacidad_nominal, v_acudiente_ids, v_id_notif_principal, FALSE, v_ahora;
END;
$$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS public.fn_verificar_alerta_judicial_activa(UUID, VARCHAR);

DROP INDEX IF EXISTS public.idx_alerta_judicial_estudiante_doc_hash;

ALTER TABLE public.alerta_judicial
    DROP CONSTRAINT IF EXISTS chk_alerta_judicial_blind_index_hex;

ALTER TABLE public.alerta_judicial
    DROP COLUMN IF EXISTS documento_restringido_hash;

COMMIT;
