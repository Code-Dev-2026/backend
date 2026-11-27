-- ============================================================================
-- CAMINO SEGURO - BACKEND CORE DDL (POSTGRESQL 16 + POSTGIS 3.4)
-- Archivo: V017__judicial_alerts_protection_engine.sql
-- Issue #10: Motor de protección preventiva contra alertas judiciales activas
-- Requisitos SRS: RF-02, RF-09, RNF-01, OWASP ASVS V1.14 (Defensa en Profundidad)
-- Reversible mediante: db/migrations/undo/U017__judicial_alerts_protection_engine.sql
-- ============================================================================

BEGIN;

-- 1. Columna determinista `documento_restringido_hash` en `public.alerta_judicial`
--    Sincronizada automáticamente con `individuo_blind_index` (V003) en minúsculas
--    para conservar compatibilidad total con V003/V016 y cumplir el contrato RF-02/RF-09.
ALTER TABLE public.alerta_judicial
    ADD COLUMN IF NOT EXISTS documento_restringido_hash VARCHAR(64)
    GENERATED ALWAYS AS (LOWER(individuo_blind_index)) STORED;

-- 2. Invariante fail-safe: el blind index judicial siempre debe ser HMAC-SHA256 válido (64 hex)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.alerta_judicial'::regclass
          AND conname = 'chk_alerta_judicial_blind_index_hex'
    ) THEN
        ALTER TABLE public.alerta_judicial
            ADD CONSTRAINT chk_alerta_judicial_blind_index_hex
            CHECK (individuo_blind_index ~ '^[a-fA-F0-9]{64}$');
    END IF;
END $$;

-- 3. Índice parcial compuesto para cruce instantáneo por estudiante y blind index activo
CREATE INDEX IF NOT EXISTS idx_alerta_judicial_estudiante_doc_hash
    ON public.alerta_judicial (id_estudiante, documento_restringido_hash)
    WHERE activa = TRUE AND eliminado_soft = FALSE;

-- 4. Función de consulta segura por blind index (sin descifrar ni exponer PII en parada)
CREATE OR REPLACE FUNCTION public.fn_verificar_alerta_judicial_activa(
    p_id_estudiante UUID,
    p_documento_restringido_hash VARCHAR(64)
)
RETURNS TABLE (
    bloqueada BOOLEAN,
    id_alerta UUID,
    radicado_medida VARCHAR(50),
    juzgado_emisor VARCHAR(150),
    documento_restringido_hash VARCHAR(64),
    fecha_registro TIMESTAMPTZ
) AS $$
#variable_conflict use_column
DECLARE
    v_hash VARCHAR(64) := NULLIF(LOWER(TRIM(p_documento_restringido_hash)), '');
    v_match RECORD;
BEGIN
    IF p_id_estudiante IS NULL THEN
        RAISE EXCEPTION 'ESTUDIANTE_REQUERIDO: El identificador del estudiante es obligatorio para la verificacion judicial.'
            USING ERRCODE = '22023';
    END IF;

    IF v_hash IS NULL OR v_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION 'BLIND_INDEX_JUDICIAL_INVALIDO: El documento_restringido_hash debe ser un HMAC-SHA256 valido de 64 caracteres hexadecimales.'
            USING ERRCODE = '22023';
    END IF;

    SELECT
        aj.id_alerta,
        aj.radicado_medida,
        aj.juzgado_emisor,
        aj.documento_restringido_hash,
        aj.fecha_registro
    INTO v_match
    FROM public.alerta_judicial aj
    WHERE aj.id_estudiante = p_id_estudiante
      AND aj.documento_restringido_hash = v_hash
      AND aj.activa = TRUE
      AND aj.eliminado_soft = FALSE
    ORDER BY aj.fecha_registro DESC
    LIMIT 1;

    IF FOUND THEN
        RETURN QUERY SELECT
            TRUE,
            v_match.id_alerta,
            v_match.radicado_medida,
            v_match.juzgado_emisor,
            v_match.documento_restringido_hash,
            v_match.fecha_registro;
        RETURN;
    END IF;

    RETURN QUERY SELECT
        FALSE,
        NULL::UUID,
        NULL::VARCHAR(50),
        NULL::VARCHAR(150),
        v_hash,
        NULL::TIMESTAMPTZ;
END;
$$ LANGUAGE plpgsql STABLE;

-- 5. Defensa en profundidad a nivel de tabla `public.entrega`:
--    Incluso ante un INSERT/UPDATE directo fuera de `fn_registrar_descenso_atomico`,
--    PostgreSQL impide matemáticamente registrar una entrega exitosa a un individuo
--    con alerta judicial activa para ese estudiante (OWASP ASVS V1.14 / RNF-01).
CREATE OR REPLACE FUNCTION public.fn_bloquear_entrega_por_alerta_judicial()
RETURNS TRIGGER AS $$
DECLARE
    v_receptor_hash VARCHAR(64);
    v_radicado VARCHAR(50);
    v_juzgado VARCHAR(150);
BEGIN
    IF NEW.estado_entrega <> 'ENTREGADO_EXITOSO' THEN
        RETURN NEW;
    END IF;

    IF NEW.id_acudiente IS NOT NULL THEN
        SELECT LOWER(a.documento_blind_index)
        INTO v_receptor_hash
        FROM public.acudiente a
        WHERE a.id_acudiente = NEW.id_acudiente;
    ELSIF NEW.id_autorizado IS NOT NULL THEN
        SELECT LOWER(aa.documento_blind_index)
        INTO v_receptor_hash
        FROM public.adulto_autorizado aa
        WHERE aa.id_autorizado = NEW.id_autorizado;
    ELSE
        RETURN NEW;
    END IF;

    IF v_receptor_hash IS NOT NULL THEN
        SELECT aj.radicado_medida, aj.juzgado_emisor
        INTO v_radicado, v_juzgado
        FROM public.alerta_judicial aj
        WHERE aj.id_estudiante = NEW.id_estudiante
          AND aj.documento_restringido_hash = v_receptor_hash
          AND aj.activa = TRUE
          AND aj.eliminado_soft = FALSE
        LIMIT 1;

        IF FOUND THEN
            RAISE EXCEPTION 'ALERTA_JUDICIAL_BLOQUEANTE: Prohibida la entrega del menor %; medida cautelar judicial activa (radicado %, juzgado %).',
                NEW.id_estudiante, v_radicado, v_juzgado
                USING ERRCODE = '42501';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bloquear_entrega_por_alerta_judicial ON public.entrega;
CREATE TRIGGER trg_bloquear_entrega_por_alerta_judicial
BEFORE INSERT OR UPDATE OF estado_entrega, id_acudiente, id_autorizado ON public.entrega
FOR EACH ROW EXECUTE FUNCTION public.fn_bloquear_entrega_por_alerta_judicial();

-- 6. Función atómica para registrar el acta de incidente judicial y encolar
--    notificaciones de emergencia SMS (`ALERTA_JUDICIAL_ACTIVADA`) a los acudientes
--    NO restringidos (ej. madre), dejando constancia de alerta a Coordinación y
--    Policía de Infancia y Adolescencia institucional.
CREATE OR REPLACE FUNCTION public.fn_registrar_incidente_alerta_judicial(
    p_id_viaje UUID,
    p_id_estudiante UUID,
    p_id_alerta UUID,
    p_documento_restringido_hash VARCHAR(64),
    p_radicado_medida VARCHAR(50),
    p_juzgado_emisor VARCHAR(150),
    p_latitud DOUBLE PRECISION,
    p_longitud DOUBLE PRECISION,
    p_registrado_por_usuario UUID DEFAULT NULL,
    p_descripcion TEXT DEFAULT NULL
)
RETURNS TABLE (
    id_incidente UUID,
    id_notificacion_principal UUID,
    id_acudientes_notificados UUID[],
    notificaciones_creadas INT,
    alerta_policia_infancia_registrada BOOLEAN,
    fecha_hora TIMESTAMPTZ
) AS $$
#variable_conflict use_column
DECLARE
    v_hash VARCHAR(64) := NULLIF(LOWER(TRIM(p_documento_restringido_hash)), '');
    v_geog GEOGRAPHY(Point, 4326) := NULL;
    v_ahora TIMESTAMPTZ := clock_timestamp();
    v_id_incidente UUID;
    v_id_tipo_notif UUID := NULL;
    v_plantilla_notif TEXT := NULL;
    v_acudiente_ids UUID[] := ARRAY[]::UUID[];
    v_acudiente_id UUID;
    v_id_notif_tmp UUID := NULL;
    v_id_notif_principal UUID := NULL;
    v_notif_count INT := 0;
    v_desc TEXT;
BEGIN
    IF p_latitud IS NOT NULL AND p_longitud IS NOT NULL THEN
        IF p_latitud < -90 OR p_latitud > 90 OR p_longitud < -180 OR p_longitud > 180 THEN
            RAISE EXCEPTION 'COORDENADAS_INVALIDAS: Rango WGS84 excedido (lat %, lon %).', p_latitud, p_longitud
                USING ERRCODE = '22023';
        END IF;
        v_geog := ST_SetSRID(ST_MakePoint(p_longitud, p_latitud), 4326)::geography;
    END IF;

    v_desc := COALESCE(
        NULLIF(TRIM(p_descripcion), ''),
        format(
            'ALERTA_JUDICIAL_BLOQUEANTE: Intento de entrega bloqueado para menor %s bajo medida cautelar activa (radicado %s, %s). Menor permanece a bordo; protocolo de emergencia activado para Coordinacion, acudiente no restringido y Policia de Infancia y Adolescencia.',
            p_id_estudiante,
            COALESCE(p_radicado_medida, 'SIN_RADICADO'),
            COALESCE(p_juzgado_emisor, 'AUTORIDAD_JUDICIAL')
        )
    );

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
        'ALERTA_JUDICIAL_DETECTADA',
        'CRITICO',
        v_desc,
        v_geog,
        v_ahora,
        p_registrado_por_usuario
    )
    RETURNING public.incidente.id_incidente INTO v_id_incidente;

    -- Seleccionar únicamente acudientes del menor cuyo blind index NO coincide con el individuo restringido
    SELECT COALESCE(
        ARRAY_AGG(ea.id_acudiente ORDER BY ea.es_tutor_principal DESC, ea.orden_notificacion ASC),
        ARRAY[]::UUID[]
    )
    INTO v_acudiente_ids
    FROM public.estudiante_acudiente ea
    JOIN public.acudiente a ON a.id_acudiente = ea.id_acudiente
    WHERE ea.id_estudiante = p_id_estudiante
      AND (v_hash IS NULL OR LOWER(a.documento_blind_index) <> v_hash);

    SELECT tn.id_tipo, tn.plantilla_mensaje
    INTO v_id_tipo_notif, v_plantilla_notif
    FROM public.tipo_notificacion tn
    WHERE tn.codigo = 'ALERTA_JUDICIAL_ACTIVADA'
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
                'SMS',
                'EMERGENCIA JUDICIAL: Intento de retiro bloqueado',
                COALESCE(
                    v_plantilla_notif,
                    'Deteccion de individuo con restriccion judicial en punto de parada. El menor permanece a bordo bajo custodia y se alerto a Coordinacion y Policia de Infancia y Adolescencia.'
                ),
                jsonb_build_object(
                    'codigo_bloqueo', 'ALERTA_JUDICIAL_BLOQUEANTE',
                    'tipo_notificacion', 'ALERTA_JUDICIAL_ACTIVADA',
                    'id_alerta', p_id_alerta,
                    'id_incidente', v_id_incidente,
                    'radicado_medida', p_radicado_medida,
                    'juzgado_emisor', p_juzgado_emisor,
                    'menor_a_bordo', TRUE,
                    'alerta_coordinacion_activada', TRUE,
                    'alerta_policia_infancia_activada', TRUE,
                    'prioridad', 'MAXIMA'
                ),
                FALSE,
                'PENDIENTE',
                'alerta_judicial:' || v_id_incidente::text || ':' || v_acudiente_id::text
            )
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING public.notificacion.id_notificacion INTO v_id_notif_tmp;

            IF v_id_notif_tmp IS NOT NULL THEN
                v_notif_count := v_notif_count + 1;
                IF v_id_notif_principal IS NULL THEN
                    v_id_notif_principal := v_id_notif_tmp;
                END IF;
            END IF;
        END LOOP;
    END IF;

    RETURN QUERY SELECT
        v_id_incidente,
        v_id_notif_principal,
        v_acudiente_ids,
        v_notif_count,
        TRUE,
        v_ahora;
END;
$$ LANGUAGE plpgsql;

-- 7. Actualización de `fn_registrar_descenso_atomico` integrando el motor judicial
--    preventivo mediante `fn_verificar_alerta_judicial_activa` y retornando
--    categóricamente `ALERTA_JUDICIAL_BLOQUEANTE` (SQLSTATE 42501) antes de cualquier
--    validación de acudiente/autorizado o mutación de aforo/custodia.
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
    v_judicial_check RECORD;
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
    -- RAMA B: ENTREGA EXITOSA CON MOTOR JUDICIAL PREVENTIVO + VALIDACIÓN DE RECEPTOR
    -- ========================================================================
    IF v_tipo_receptor_final IS NULL OR v_tipo_receptor_final NOT IN ('ACUDIENTE', 'ADULTO_AUTORIZADO', 'SEDE_EDUCATIVA') THEN
        RAISE EXCEPTION 'TIPO_RECEPTOR_INVALIDO: Tipo de receptor % no soportado para entrega exitosa.', COALESCE(v_tipo_receptor_final, 'NULL')
            USING ERRCODE = '22023';
    END IF;

    -- Prioridad absoluta de protección al menor (RF-02, RF-09, RNF-01, ASVS V1.14):
    -- Si llega un blind index de receptor, cotejar SIEMPRE primero contra `alerta_judicial.documento_restringido_hash`.
    IF v_blind_index IS NOT NULL THEN
        SELECT *
        INTO v_judicial_check
        FROM public.fn_verificar_alerta_judicial_activa(p_id_estudiante, v_blind_index);

        IF v_judicial_check.bloqueada IS TRUE THEN
            RAISE EXCEPTION 'ALERTA_JUDICIAL_BLOQUEANTE: Prohibida la entrega del menor %; existe medida cautelar judicial activa (radicado %, juzgado %).',
                p_id_estudiante, v_judicial_check.radicado_medida, v_judicial_check.juzgado_emisor
                USING ERRCODE = '42501';
        END IF;
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

    -- 9. Inserción independiente en public.entrega (protegida además por trg_bloquear_entrega_por_alerta_judicial)
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

-- 8. Privilegios mínimos sobre las funciones del motor judicial (OWASP ASVS V1.14)
--    `app_user_operations` conserva SOLO lectura sobre `alerta_judicial` (sin INSERT/UPDATE/DELETE).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        GRANT EXECUTE ON FUNCTION public.fn_verificar_alerta_judicial_activa(UUID, VARCHAR) TO app_user;
        GRANT EXECUTE ON FUNCTION public.fn_registrar_incidente_alerta_judicial(
            UUID, UUID, UUID, VARCHAR, VARCHAR, VARCHAR, DOUBLE PRECISION, DOUBLE PRECISION, UUID, TEXT
        ) TO app_user;
        GRANT EXECUTE ON FUNCTION public.fn_registrar_descenso_atomico(
            UUID, UUID, VARCHAR, VARCHAR, VARCHAR, UUID, VARCHAR, DOUBLE PRECISION, DOUBLE PRECISION, UUID, TEXT, TEXT, VARCHAR, BOOLEAN
        ) TO app_user;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user_operations') THEN
        GRANT EXECUTE ON FUNCTION public.fn_verificar_alerta_judicial_activa(UUID, VARCHAR) TO app_user_operations;
        GRANT EXECUTE ON FUNCTION public.fn_registrar_incidente_alerta_judicial(
            UUID, UUID, UUID, VARCHAR, VARCHAR, VARCHAR, DOUBLE PRECISION, DOUBLE PRECISION, UUID, TEXT
        ) TO app_user_operations;
        GRANT EXECUTE ON FUNCTION public.fn_registrar_descenso_atomico(
            UUID, UUID, VARCHAR, VARCHAR, VARCHAR, UUID, VARCHAR, DOUBLE PRECISION, DOUBLE PRECISION, UUID, TEXT, TEXT, VARCHAR, BOOLEAN
        ) TO app_user_operations;
    END IF;
END $$;

COMMIT;
