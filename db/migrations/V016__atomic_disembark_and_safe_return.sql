-- ============================================================================
-- CAMINO SEGURO - BACKEND CORE DDL (POSTGRESQL 16 + POSTGIS 3.4)
-- Archivo: V016__atomic_disembark_and_safe_return.sql
-- Issue #9: Validación de receptores de entrega, desembarque seguro y retorno a sede
-- Requisitos SRS: RF-09, RF-11, RN-04, OWASP ASVS V4.1
-- Reversible mediante: db/migrations/undo/U016__atomic_disembark_and_safe_return.sql
-- ============================================================================

BEGIN;

-- 1. Alinear restricciones CHECK de public.entrega para soportar ADULTO_AUTORIZADO
--    y SEDE_EDUCATIVA conservando compatibilidad con AUTORIZADO y RETORNO_SEDE_ESCOLAR (V006)
DO $$
DECLARE
    v_constraint_name TEXT;
BEGIN
    FOR v_constraint_name IN (
        SELECT c.conname
        FROM pg_constraint c
        WHERE c.conrelid = 'public.entrega'::regclass
          AND c.contype = 'c'
          AND (
              c.conname = 'chk_entrega_estado_coherente'
              OR pg_get_constraintdef(c.oid) ILIKE '%tipo_receptor%'
          )
    ) LOOP
        EXECUTE format(
            'ALTER TABLE public.entrega DROP CONSTRAINT %I;',
            v_constraint_name
        );
    END LOOP;
END $$;

ALTER TABLE public.entrega
    ADD CONSTRAINT chk_entrega_tipo_receptor
    CHECK (tipo_receptor IN (
        'ACUDIENTE',
        'AUTORIZADO',
        'ADULTO_AUTORIZADO',
        'SEDE_EDUCATIVA',
        'RETORNO_SEDE_ESCOLAR'
    ));

ALTER TABLE public.entrega
    ADD CONSTRAINT chk_entrega_estado_coherente
    CHECK (
        (estado_entrega = 'ENTREGADO_EXITOSO' AND tipo_receptor = 'ACUDIENTE' AND id_acudiente IS NOT NULL AND id_autorizado IS NULL) OR
        (estado_entrega = 'ENTREGADO_EXITOSO' AND tipo_receptor IN ('AUTORIZADO', 'ADULTO_AUTORIZADO') AND id_autorizado IS NOT NULL AND id_acudiente IS NULL) OR
        (estado_entrega = 'ENTREGADO_EXITOSO' AND tipo_receptor = 'SEDE_EDUCATIVA' AND id_acudiente IS NULL AND id_autorizado IS NULL) OR
        (estado_entrega = 'DESEMBARQUE_FALLIDO_RETORNO' AND tipo_receptor = 'RETORNO_SEDE_ESCOLAR' AND id_acudiente IS NULL AND id_autorizado IS NULL)
    );

-- 2. Clave de idempotencia sobre public.entrega para reintentos móviles sin entregas duplicadas
ALTER TABLE public.entrega
    ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(120);

CREATE UNIQUE INDEX IF NOT EXISTS uq_entrega_idempotency_key
    ON public.entrega (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- 3. Extender el bloqueo de cierre de viaje (V014) para impedir FINALIZADO mientras existan
--    estudiantes en A_BORDO_VEHICULO o RETORNO_SEDE_POR_FALLA_ENTREGA (aún a bordo hasta acta en sede)
CREATE OR REPLACE FUNCTION public.fn_bloquear_cierre_viaje_con_menores_a_bordo()
RETURNS TRIGGER AS $$
DECLARE
    v_menores_a_bordo INT;
BEGIN
    SELECT COUNT(*)
    INTO v_menores_a_bordo
    FROM public.viaje_estudiante
    WHERE id_viaje = NEW.id_viaje
      AND estado_custodia IN ('A_BORDO_VEHICULO', 'RETORNO_SEDE_POR_FALLA_ENTREGA');

    IF v_menores_a_bordo > 0 THEN
        RAISE EXCEPTION 'BLOQUEO_CIERRE_VIAJE_CUSTODIA: No se puede cerrar el viaje % a FINALIZADO porque aun existen % estudiante(s) a bordo o en retorno seguro a sede.',
            NEW.id_viaje, v_menores_a_bordo
            USING ERRCODE = '23514';
    END IF;

    NEW.hora_fin_real := COALESCE(NEW.hora_fin_real, clock_timestamp());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4. Función almacenada atómica de desembarque seguro y protocolo de retorno a sede (RF-09, RF-11, RN-04, ASVS V4.1)
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
    -- 1. Validación estricta de parámetros de entrada (fail-safe)
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

    -- 2. Bloqueo pesimista FOR UPDATE sobre public.viaje (serializa liberación de cupo)
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

    -- 3. Verificación de estudiante activo
    SELECT e.activo
    INTO v_estudiante_activo
    FROM public.estudiante e
    WHERE e.id_estudiante = p_id_estudiante;

    IF NOT FOUND OR v_estudiante_activo IS NOT TRUE THEN
        RAISE EXCEPTION 'ESTUDIANTE_NO_ENCONTRADO: El estudiante % no existe o esta inactivo.', p_id_estudiante
            USING ERRCODE = 'P0002';
    END IF;

    -- 4. Verificación de idempotencia (evita doble decremento de total_a_bordo en reintentos)
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

    -- 5. Bloqueo de viaje_estudiante y verificación de que el menor esté A_BORDO_VEHICULO
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

    -- Acudientes vinculados al menor para notificación inmediata
    SELECT COALESCE(ARRAY_AGG(ea.id_acudiente ORDER BY ea.es_tutor_principal DESC, ea.orden_notificacion ASC), ARRAY[]::UUID[])
    INTO v_acudiente_ids
    FROM public.estudiante_acudiente ea
    WHERE ea.id_estudiante = p_id_estudiante;

    SELECT COALESCE(MAX(ent.intento_secuencia), 0) + 1
    INTO v_intento_secuencia
    FROM public.entrega ent
    WHERE ent.id_viaje = p_id_viaje
      AND ent.id_estudiante = p_id_estudiante;

    -- ========================================================================
    -- RAMA A: DESEMBARQUE FALLIDO / PROTOCOLO DE RETORNO SEGURO A SEDE (RF-11)
    -- ========================================================================
    IF v_resultado_final = 'DESEMBARQUE_FALLIDO_RETORNO' THEN
        IF v_tipo_recorrido <> 'TARDE' THEN
            RAISE EXCEPTION 'RECORRIDO_INCOMPATIBLE_DESCENSO: El protocolo DESEMBARQUE_FALLIDO_RETORNO solo aplica en recorridos de TARDE.'
                USING ERRCODE = '23514';
        END IF;

        -- NO se decrementa viaje.total_a_bordo: el menor continúa contabilizado a bordo hasta acta formal en sede
        v_nuevo_total := v_total_actual;

        INSERT INTO public.entrega (
            id_viaje,
            id_estudiante,
            intento_secuencia,
            tipo_receptor,
            id_acudiente,
            id_autorizado,
            estado_entrega,
            foto_evidencia_url,
            coordenada,
            observaciones_fallido,
            fecha_hora,
            idempotency_key
        )
        VALUES (
            p_id_viaje,
            p_id_estudiante,
            v_intento_secuencia,
            'RETORNO_SEDE_ESCOLAR',
            NULL,
            NULL,
            'DESEMBARQUE_FALLIDO_RETORNO',
            p_foto_evidencia_url,
            v_geog,
            COALESCE(NULLIF(TRIM(p_observaciones_fallido), ''), 'Ningun adulto autorizado comparecio en la parada; se activa retorno seguro a sede escolar.'),
            v_ahora,
            v_idempotency_key
        )
        RETURNING public.entrega.id_entrega INTO v_id_entrega;

        -- Transición FSM WORM SHA-256: A_BORDO_VEHICULO -> RETORNO_SEDE_POR_FALLA_ENTREGA
        PERFORM * FROM public.fn_registrar_transicion_custodia(
            p_id_viaje,
            p_id_estudiante,
            'RETORNO_SEDE_POR_FALLA_ENTREGA',
            'TARDE',
            'DESEMBARQUE_FALLIDO_RETORNO',
            p_registrado_por_usuario,
            p_latitud,
            p_longitud
        );

        -- Incidente crítico de custodia (RF-11)
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
            p_id_estudiante,
            'DESEMBARQUE_FALLIDO_RETORNO',
            'CRITICO',
            COALESCE(
                NULLIF(TRIM(p_observaciones_fallido), ''),
                format('Protocolo RF-11 activado: no comparecio receptor acreditado para el estudiante %s en viaje %s. Menor permanece a bordo rumbo a sede escolar.', p_id_estudiante, p_id_viaje)
            ),
            v_geog,
            v_ahora,
            p_registrado_por_usuario
        )
        RETURNING public.incidente.id_incidente INTO v_id_incidente;

        -- Encolamiento inmediato de alertas críticas a todos los acudientes vinculados
        SELECT tn.id_tipo, tn.plantilla_mensaje, tn.canal_default
        INTO v_id_tipo_notif, v_plantilla_notif, v_canal_notif
        FROM public.tipo_notificacion tn
        WHERE tn.codigo = 'INCIDENTE_ENTREGA'
        LIMIT 1;

        IF v_id_tipo_notif IS NOT NULL AND array_length(v_acudiente_ids, 1) IS NOT NULL THEN
            FOREACH v_acudiente_id IN ARRAY v_acudiente_ids LOOP
                INSERT INTO public.notificacion (
                    id_tipo,
                    id_estudiante,
                    id_acudiente,
                    id_viaje,
                    canal,
                    titulo,
                    contenido_mensaje,
                    payload_adicional,
                    silenciable,
                    estado_envio,
                    idempotency_key
                )
                VALUES (
                    v_id_tipo_notif,
                    p_id_estudiante,
                    v_acudiente_id,
                    p_id_viaje,
                    COALESCE(v_canal_notif, 'SMS'),
                    'Alerta crítica: retorno seguro a sede escolar',
                    COALESCE(v_plantilla_notif, 'No se pudo entregar al menor en parada; permanece a bordo rumbo a la sede escolar.'),
                    jsonb_build_object(
                        'id_viaje', p_id_viaje,
                        'id_entrega', v_id_entrega,
                        'id_incidente', v_id_incidente,
                        'estado_custodia', 'RETORNO_SEDE_POR_FALLA_ENTREGA',
                        'total_a_bordo', v_nuevo_total
                    ),
                    FALSE,
                    'PENDIENTE',
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
            FALSE,
            'DESEMBARQUE_FALLIDO_RETORNO'::VARCHAR(40),
            format('Protocolo de retorno seguro a sede activado: el estudiante %s permanece a bordo (%s/%s).',
                   p_id_estudiante, v_nuevo_total, v_capacidad_nominal),
            p_id_viaje,
            v_id_ruta,
            p_id_estudiante,
            v_id_entrega,
            NULL::UUID,
            v_id_incidente,
            'RETORNO_SEDE_ESCOLAR'::VARCHAR(30),
            NULL::UUID,
            NULL::UUID,
            'DESEMBARQUE_FALLIDO_RETORNO'::VARCHAR(30),
            'RETORNO_SEDE_POR_FALLA_ENTREGA'::VARCHAR(30),
            v_metodo_final,
            v_nuevo_total,
            v_capacidad_nominal,
            v_acudiente_ids,
            v_id_notif_principal,
            FALSE,
            v_ahora;
        RETURN;
    END IF;

    -- ========================================================================
    -- RAMA B: ENTREGA EXITOSA CON VALIDACIÓN ESTRICTA DE RECEPTOR (RF-09, RN-04, ASVS V4.1)
    -- ========================================================================
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

        -- Prioridad absoluta de seguridad: verificar alerta judicial activa para el menor (RF-07 / ASVS V4.1)
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
            -- ADULTO_AUTORIZADO: verificar invariante RN-04 (máximo 3 autorizados activos)
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
                aa.id_autorizado,
                aa.activo,
                ea.activo,
                ea.autorizado_hasta,
                COALESCE(ec.revocado, FALSE)
            INTO
                v_id_autorizado_receptor,
                v_adulto_activo,
                v_autorizado_activo,
                v_autorizado_hasta,
                v_expediente_revocado
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

    -- 6. Verificar que no exista descenso previo en registro_de_asistencia
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

    -- 7. Liberación atómica de cupo (total_a_bordo - 1)
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

    -- 8. Inserción transaccional en registro_de_asistencia (tipo_evento = 'DESCENSO')
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
        p_id_estudiante,
        'DESCENSO',
        v_metodo_final,
        v_geog,
        v_ahora,
        COALESCE(p_sincronizado_offline, FALSE),
        v_idempotency_key
    )
    RETURNING public.registro_de_asistencia.id_asistencia INTO v_id_asistencia;

    -- 9. Inserción independiente en public.entrega (una fila garantizada por cada estudiante)
    INSERT INTO public.entrega (
        id_viaje,
        id_estudiante,
        intento_secuencia,
        tipo_receptor,
        id_acudiente,
        id_autorizado,
        estado_entrega,
        foto_evidencia_url,
        coordenada,
        observaciones_fallido,
        fecha_hora,
        idempotency_key
    )
    VALUES (
        p_id_viaje,
        p_id_estudiante,
        v_intento_secuencia,
        v_tipo_receptor_final,
        v_id_acudiente_receptor,
        v_id_autorizado_receptor,
        'ENTREGADO_EXITOSO',
        p_foto_evidencia_url,
        v_geog,
        NULL,
        v_ahora,
        v_idempotency_key
    )
    RETURNING public.entrega.id_entrega INTO v_id_entrega;

    -- 10. Sincronización FSM WORM SHA-256 (Issue #7)
    PERFORM * FROM public.fn_registrar_transicion_custodia(
        p_id_viaje,
        p_id_estudiante,
        v_estado_custodia_destino,
        v_tipo_recorrido,
        CASE
            WHEN v_tipo_receptor_final = 'SEDE_EDUCATIVA' THEN 'DESEMBARQUE_SEDE_EDUCATIVA'
            WHEN v_tipo_receptor_final = 'ACUDIENTE' THEN 'ENTREGA_ACUDIENTE'
            ELSE 'ENTREGA_ADULTO_AUTORIZADO'
        END,
        p_registrado_por_usuario,
        p_latitud,
        p_longitud
    );

    -- 11. Encolamiento de notificación de entrega exitosa a los acudientes vinculados
    SELECT tn.id_tipo, tn.plantilla_mensaje
    INTO v_id_tipo_notif, v_plantilla_notif
    FROM public.tipo_notificacion tn
    WHERE tn.codigo = 'DESCENSO_EXITOSO'
    LIMIT 1;

    IF v_id_tipo_notif IS NOT NULL AND array_length(v_acudiente_ids, 1) IS NOT NULL THEN
        FOREACH v_acudiente_id IN ARRAY v_acudiente_ids LOOP
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
                p_id_estudiante,
                v_acudiente_id,
                p_id_viaje,
                'PUSH',
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
        TRUE,
        'DESCENSO_EXITOSO'::VARCHAR(40),
        format('Descenso y entrega registrados exitosamente (%s/%s pasajeros a bordo).',
               v_nuevo_total, v_capacidad_nominal),
        p_id_viaje,
        v_id_ruta,
        p_id_estudiante,
        v_id_entrega,
        v_id_asistencia,
        NULL::UUID,
        v_tipo_receptor_final,
        v_id_acudiente_receptor,
        v_id_autorizado_receptor,
        'ENTREGADO_EXITOSO'::VARCHAR(30),
        v_estado_custodia_destino,
        v_metodo_final,
        v_nuevo_total,
        v_capacidad_nominal,
        v_acudiente_ids,
        v_id_notif_principal,
        FALSE,
        v_ahora;
END;
$$ LANGUAGE plpgsql;

-- 5. Función almacenada atómica de cierre formal de custodia en sede escolar (/asistencia/custodia/finalizar-sede)
CREATE OR REPLACE FUNCTION public.fn_finalizar_custodia_sede_atomico(
    p_id_viaje UUID,
    p_id_estudiante UUID,
    p_recibido_por_coordinador UUID,
    p_latitud DOUBLE PRECISION,
    p_longitud DOUBLE PRECISION,
    p_registrado_por_usuario UUID DEFAULT NULL,
    p_observaciones TEXT DEFAULT NULL,
    p_idempotency_key VARCHAR(120) DEFAULT NULL
)
RETURNS TABLE (
    finalizado BOOLEAN,
    codigo VARCHAR(40),
    mensaje TEXT,
    id_viaje UUID,
    id_ruta UUID,
    id_estudiante UUID,
    id_entrega UUID,
    id_acta UUID,
    id_asistencia UUID,
    recibido_por_coordinador UUID,
    firma_digital_hash TEXT,
    estado_custodia VARCHAR(30),
    total_a_bordo INT,
    capacidad_nominal INT,
    id_acudientes_notificados UUID[],
    id_notificacion_principal UUID,
    fecha_recepcion TIMESTAMPTZ
) AS $$
#variable_conflict use_column
DECLARE
    v_id_ruta UUID;
    v_estado_viaje VARCHAR(20);
    v_total_actual INT;
    v_nuevo_total INT;
    v_capacidad_nominal INT;
    v_id_colegio_estudiante UUID;
    v_id_colegio_coordinador UUID;
    v_estado_custodia_actual VARCHAR(30);
    v_id_entrega_fallida UUID;
    v_id_acta UUID;
    v_id_asistencia UUID;
    v_firma_hash TEXT;
    v_geog GEOGRAPHY(Point, 4326);
    v_ahora TIMESTAMPTZ := clock_timestamp();
    v_obs TEXT := NULLIF(TRIM(p_observaciones), '');
    v_idempotency_key VARCHAR(120) := NULLIF(TRIM(p_idempotency_key), '');
    v_acudiente_ids UUID[] := ARRAY[]::UUID[];
    v_acudiente_id UUID;
    v_id_tipo_notif UUID := NULL;
    v_id_notif_tmp UUID := NULL;
    v_id_notif_principal UUID := NULL;
BEGIN
    IF p_latitud IS NULL OR p_longitud IS NULL OR p_latitud < -90 OR p_latitud > 90 OR p_longitud < -180 OR p_longitud > 180 THEN
        RAISE EXCEPTION 'COORDENADAS_INVALIDAS: Latitud y longitud WGS84 validas son obligatorias.'
            USING ERRCODE = '22023';
    END IF;

    v_geog := ST_SetSRID(ST_MakePoint(p_longitud, p_latitud), 4326)::geography;

    -- 1. Bloqueo pesimista sobre public.viaje
    SELECT
        v.id_ruta,
        v.estado,
        v.total_a_bordo,
        veh.capacidad_nominal
    INTO
        v_id_ruta,
        v_estado_viaje,
        v_total_actual,
        v_capacidad_nominal
    FROM public.viaje v
    JOIN public.vehiculo veh ON veh.id_vehiculo = v.id_vehiculo
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

    -- 2. Verificar estudiante y coordinador del mismo colegio (ASVS V4.1)
    SELECT e.id_colegio
    INTO v_id_colegio_estudiante
    FROM public.estudiante e
    WHERE e.id_estudiante = p_id_estudiante
      AND e.activo = TRUE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ESTUDIANTE_NO_ENCONTRADO: El estudiante % no existe o esta inactivo.', p_id_estudiante
            USING ERRCODE = 'P0002';
    END IF;

    SELECT c.id_colegio
    INTO v_id_colegio_coordinador
    FROM public.coordinador c
    WHERE c.id_coordinador = p_recibido_por_coordinador;

    IF NOT FOUND OR v_id_colegio_coordinador <> v_id_colegio_estudiante THEN
        RAISE EXCEPTION 'COORDINADOR_NO_AUTORIZADO: El coordinador % no esta autorizado para recibir estudiantes del colegio del menor %.',
            p_recibido_por_coordinador, p_id_estudiante
            USING ERRCODE = '42501';
    END IF;

    -- 3. Verificar estado RETORNO_SEDE_POR_FALLA_ENTREGA en viaje_estudiante
    SELECT ve.estado_custodia
    INTO v_estado_custodia_actual
    FROM public.viaje_estudiante ve
    WHERE ve.id_viaje = p_id_viaje
      AND ve.id_estudiante = p_id_estudiante
    FOR UPDATE;

    IF NOT FOUND OR v_estado_custodia_actual <> 'RETORNO_SEDE_POR_FALLA_ENTREGA' THEN
        RAISE EXCEPTION 'ESTUDIANTE_NO_EN_RETORNO_SEDE: El estudiante % debe estar en estado RETORNO_SEDE_POR_FALLA_ENTREGA (actual: %).',
            p_id_estudiante, COALESCE(v_estado_custodia_actual, 'NO_MATRICULADO')
            USING ERRCODE = '23514';
    END IF;

    -- 4. Localizar el registro de entrega fallida asociado y verificar que no tenga acta previa
    SELECT ent.id_entrega
    INTO v_id_entrega_fallida
    FROM public.entrega ent
    WHERE ent.id_viaje = p_id_viaje
      AND ent.id_estudiante = p_id_estudiante
      AND ent.estado_entrega = 'DESEMBARQUE_FALLIDO_RETORNO'
    ORDER BY ent.intento_secuencia DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ENTREGA_FALLIDA_NO_ENCONTRADA: No existe un registro de DESEMBARQUE_FALLIDO_RETORNO para el estudiante % en el viaje %.',
            p_id_estudiante, p_id_viaje
            USING ERRCODE = 'P0002';
    END IF;

    IF EXISTS (SELECT 1 FROM public.acta_custodia ac WHERE ac.id_entrega = v_id_entrega_fallida) THEN
        RAISE EXCEPTION 'ACTA_CUSTODIA_EXISTENTE: Ya existe un acta de custodia en sede para la entrega %.', v_id_entrega_fallida
            USING ERRCODE = '23505';
    END IF;

    -- 5. Liberar el cupo (total_a_bordo - 1) ÚNICAMENTE al certificar recepción formal en sede
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

    -- 6. Registrar descenso formal en registro_de_asistencia
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
        p_id_estudiante,
        'DESCENSO',
        'VERIFICACION_VISUAL_PARADA',
        v_geog,
        v_ahora,
        FALSE,
        v_idempotency_key
    )
    RETURNING public.registro_de_asistencia.id_asistencia INTO v_id_asistencia;

    -- 7. Emitir acta_custodia con firma digital SHA-256 no repudiable (ASVS V4.1)
    v_firma_hash := encode(
        digest(
            v_id_entrega_fallida::text || '|' ||
            p_id_estudiante::text || '|' ||
            p_recibido_por_coordinador::text || '|' ||
            to_char(v_ahora AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' ||
            COALESCE(v_obs, 'RECEPCION_FORMAL_SEDE'),
            'sha256'
        ),
        'hex'
    );

    INSERT INTO public.acta_custodia (
        id_entrega,
        id_estudiante,
        recibido_por_coordinador,
        fecha_recepcion,
        firma_digital_hash,
        observaciones
    )
    VALUES (
        v_id_entrega_fallida,
        p_id_estudiante,
        p_recibido_por_coordinador,
        v_ahora,
        v_firma_hash,
        v_obs
    )
    RETURNING public.acta_custodia.id_acta INTO v_id_acta;

    -- 8. Transición FSM WORM SHA-256: RETORNO_SEDE_POR_FALLA_ENTREGA -> EN_COLEGIO
    PERFORM * FROM public.fn_registrar_transicion_custodia(
        p_id_viaje,
        p_id_estudiante,
        'EN_COLEGIO',
        'TARDE',
        'RECEPCION_SEDE_COORDINACION',
        p_registrado_por_usuario,
        p_latitud,
        p_longitud
    );

    -- 9. Notificación a los acudientes confirmando recepción segura en sede escolar
    SELECT COALESCE(ARRAY_AGG(ea.id_acudiente ORDER BY ea.es_tutor_principal DESC, ea.orden_notificacion ASC), ARRAY[]::UUID[])
    INTO v_acudiente_ids
    FROM public.estudiante_acudiente ea
    WHERE ea.id_estudiante = p_id_estudiante;

    SELECT tn.id_tipo
    INTO v_id_tipo_notif
    FROM public.tipo_notificacion tn
    WHERE tn.codigo = 'DESCENSO_EXITOSO'
    LIMIT 1;

    IF v_id_tipo_notif IS NOT NULL AND array_length(v_acudiente_ids, 1) IS NOT NULL THEN
        FOREACH v_acudiente_id IN ARRAY v_acudiente_ids LOOP
            INSERT INTO public.notificacion (
                id_tipo,
                id_estudiante,
                id_acudiente,
                id_viaje,
                canal,
                titulo,
                contenido_mensaje,
                payload_adicional,
                silenciable,
                estado_envio,
                idempotency_key
            )
            VALUES (
                v_id_tipo_notif,
                p_id_estudiante,
                v_acudiente_id,
                p_id_viaje,
                'PUSH',
                'Estudiante recibido en sede escolar',
                'El estudiante fue recibido formalmente en Coordinación de la sede escolar bajo acta de custodia.',
                jsonb_build_object(
                    'id_viaje', p_id_viaje,
                    'id_entrega', v_id_entrega_fallida,
                    'id_acta', v_id_acta,
                    'recibido_por_coordinador', p_recibido_por_coordinador,
                    'estado_custodia', 'EN_COLEGIO',
                    'total_a_bordo', v_nuevo_total
                ),
                FALSE,
                'PENDIENTE',
                'acta_sede:' || v_id_acta::text || ':' || v_acudiente_id::text
            )
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING public.notificacion.id_notificacion INTO v_id_notif_tmp;

            IF v_id_notif_principal IS NULL AND v_id_notif_tmp IS NOT NULL THEN
                v_id_notif_principal := v_id_notif_tmp;
            END IF;
        END LOOP;
    END IF;

    RETURN QUERY SELECT
        TRUE,
        'CUSTODIA_SEDE_FINALIZADA'::VARCHAR(40),
        format('Custodia en sede certificada formalmente con acta %s (%s/%s pasajeros a bordo).',
               v_id_acta, v_nuevo_total, v_capacidad_nominal),
        p_id_viaje,
        v_id_ruta,
        p_id_estudiante,
        v_id_entrega_fallida,
        v_id_acta,
        v_id_asistencia,
        p_recibido_por_coordinador,
        v_firma_hash,
        'EN_COLEGIO'::VARCHAR(30),
        v_nuevo_total,
        v_capacidad_nominal,
        v_acudiente_ids,
        v_id_notif_principal,
        v_ahora;
END;
$$ LANGUAGE plpgsql;

-- 6. Privilegios mínimos sobre funciones y tabla acudiente para app_user y app_user_operations (ASVS V1.14)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        GRANT EXECUTE ON FUNCTION public.fn_registrar_descenso_atomico(
            UUID, UUID, VARCHAR, VARCHAR, VARCHAR, UUID, VARCHAR, DOUBLE PRECISION, DOUBLE PRECISION, UUID, TEXT, TEXT, VARCHAR, BOOLEAN
        ) TO app_user;
        GRANT EXECUTE ON FUNCTION public.fn_finalizar_custodia_sede_atomico(
            UUID, UUID, UUID, DOUBLE PRECISION, DOUBLE PRECISION, UUID, TEXT, VARCHAR
        ) TO app_user;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user_operations') THEN
        GRANT SELECT ON public.acudiente TO app_user_operations;
        GRANT EXECUTE ON FUNCTION public.fn_registrar_descenso_atomico(
            UUID, UUID, VARCHAR, VARCHAR, VARCHAR, UUID, VARCHAR, DOUBLE PRECISION, DOUBLE PRECISION, UUID, TEXT, TEXT, VARCHAR, BOOLEAN
        ) TO app_user_operations;
        GRANT EXECUTE ON FUNCTION public.fn_finalizar_custodia_sede_atomico(
            UUID, UUID, UUID, DOUBLE PRECISION, DOUBLE PRECISION, UUID, TEXT, VARCHAR
        ) TO app_user_operations;
    END IF;
END $$;

COMMIT;
