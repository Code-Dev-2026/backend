-- ============================================================================
-- MIGRACIÓN V006: ASISTENCIA, CONTROL DE CUSTODIA, INCIDENTES Y MANIFIESTO DE VIAJE
-- ============================================================================
BEGIN;

-- Tablas de Soporte para Novedades e Incidentes (RF-08, RF-13, RF-16)
CREATE TABLE IF NOT EXISTS aval_coordinacion (
    id_aval UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_viaje UUID NOT NULL REFERENCES viaje(id_viaje) ON DELETE RESTRICT,
    avalado_por_coordinador UUID NOT NULL REFERENCES coordinador(id_coordinador) ON DELETE RESTRICT,
    tipo_aval VARCHAR(50) NOT NULL 
        CHECK (tipo_aval IN ('TRANSBORDO_EMERGENCIA', 'CAMBIO_CHOFER', 'EXCEPCION_ENTREGA_SIGUIENTE_PARADA', 'DESVIO_OPERATIVO_JUSTIFICADO')),
    justificativa TEXT NOT NULL,
    fecha_aval TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS incidente (
    id_incidente UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_viaje UUID NOT NULL REFERENCES viaje(id_viaje) ON DELETE RESTRICT,
    id_estudiante UUID REFERENCES estudiante(id_estudiante) ON DELETE SET NULL,
    tipo_incidente VARCHAR(50) NOT NULL,
    severidad VARCHAR(20) NOT NULL CHECK (severidad IN ('INFORMATIVO', 'ADVERTENCIA', 'CRITICO')),
    descripcion TEXT NOT NULL,
    coordenada GEOGRAPHY(Point, 4326),
    fecha_hora TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    registrado_por_usuario UUID REFERENCES usuario(id_usuario) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_incidente_viaje ON incidente(id_viaje, severidad);

CREATE TABLE IF NOT EXISTS registro_de_asistencia (
    id_asistencia UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_viaje UUID NOT NULL REFERENCES viaje(id_viaje) ON DELETE RESTRICT,
    id_estudiante UUID NOT NULL REFERENCES estudiante(id_estudiante) ON DELETE RESTRICT,
    tipo_evento VARCHAR(20) NOT NULL CHECK (tipo_evento IN ('ABORDAJE', 'DESCENSO')),
    metodo_validacion VARCHAR(30) NOT NULL 
        CHECK (metodo_validacion IN ('QR_INSTITUCIONAL', 'QR_OCASIONAL_TEMPORAL', 'VERIFICACION_VISUAL_PARADA')),
    coordenada GEOGRAPHY(Point, 4326) NOT NULL,
    fecha_hora TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sincronizado_offline BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT uq_asistencia_viaje_evento UNIQUE (id_viaje, id_estudiante, tipo_evento)
);
CREATE INDEX IF NOT EXISTS idx_asistencia_coordenada ON registro_de_asistencia USING GIST (coordenada);

CREATE TABLE IF NOT EXISTS entrega (
    id_entrega UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_viaje UUID NOT NULL REFERENCES viaje(id_viaje) ON DELETE RESTRICT,
    id_estudiante UUID NOT NULL REFERENCES estudiante(id_estudiante) ON DELETE RESTRICT,
    intento_secuencia INT NOT NULL DEFAULT 1, -- Permite reintento en siguiente parada con aval (RF-08)
    tipo_receptor VARCHAR(30) NOT NULL CHECK (tipo_receptor IN ('ACUDIENTE', 'AUTORIZADO', 'RETORNO_SEDE_ESCOLAR')),
    id_acudiente UUID,
    id_autorizado UUID,
    estado_entrega VARCHAR(30) NOT NULL CHECK (estado_entrega IN ('ENTREGADO_EXITOSO', 'DESEMBARQUE_FALLIDO_RETORNO')),
    id_aval_coordinacion UUID REFERENCES aval_coordinacion(id_aval) ON DELETE RESTRICT,
    foto_evidencia_url TEXT,
    coordenada GEOGRAPHY(Point, 4326) NOT NULL,
    observaciones_fallido TEXT,
    fecha_hora TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Unicidad por intento (soporta reintento avalado de entrega sin colisión)
    CONSTRAINT uq_entrega_intento UNIQUE (id_viaje, id_estudiante, intento_secuencia),
    CONSTRAINT fk_entrega_estudiante_acudiente 
        FOREIGN KEY (id_estudiante, id_acudiente) REFERENCES estudiante_acudiente(id_estudiante, id_acudiente) ON DELETE RESTRICT,
    CONSTRAINT fk_entrega_estudiante_autorizado 
        FOREIGN KEY (id_estudiante, id_autorizado) REFERENCES estudiante_autorizado(id_estudiante, id_autorizado) ON DELETE RESTRICT,
    CONSTRAINT chk_entrega_estado_coherente CHECK (
        (estado_entrega = 'ENTREGADO_EXITOSO' AND tipo_receptor = 'ACUDIENTE' AND id_acudiente IS NOT NULL AND id_autorizado IS NULL) OR
        (estado_entrega = 'ENTREGADO_EXITOSO' AND tipo_receptor = 'AUTORIZADO' AND id_autorizado IS NOT NULL AND id_acudiente IS NULL) OR
        (estado_entrega = 'DESEMBARQUE_FALLIDO_RETORNO' AND tipo_receptor = 'RETORNO_SEDE_ESCOLAR' AND id_acudiente IS NULL AND id_autorizado IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS idx_entrega_coordenada ON entrega USING GIST (coordenada);

CREATE TABLE IF NOT EXISTS acta_custodia (
    id_acta UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_entrega UUID NOT NULL UNIQUE REFERENCES entrega(id_entrega) ON DELETE RESTRICT,
    id_estudiante UUID NOT NULL REFERENCES estudiante(id_estudiante) ON DELETE RESTRICT,
    recibido_por_coordinador UUID NOT NULL REFERENCES coordinador(id_coordinador) ON DELETE RESTRICT,
    fecha_recepcion TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    firma_digital_hash TEXT NOT NULL,
    observaciones TEXT
);

CREATE TABLE IF NOT EXISTS historial_estado_custodia (
    secuencia BIGINT PRIMARY KEY,
    id_historial UUID NOT NULL UNIQUE DEFAULT fn_uuid_generate_v7(),
    id_estudiante UUID NOT NULL REFERENCES estudiante(id_estudiante) ON DELETE RESTRICT,
    id_viaje UUID NOT NULL REFERENCES viaje(id_viaje) ON DELETE RESTRICT,
    estado_origen VARCHAR(30) NOT NULL,
    estado_destino VARCHAR(30) NOT NULL,
    disparador_evento VARCHAR(50) NOT NULL,
    coordenadas_gps GEOGRAPHY(Point, 4326),
    fecha_hora TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    registrado_por_usuario UUID REFERENCES usuario(id_usuario) ON DELETE RESTRICT,
    hash_sha256_anterior VARCHAR(64) NOT NULL,
    hash_sha256_actual VARCHAR(64) NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_historial_estudiante_tiempo ON historial_estado_custodia(id_estudiante, fecha_hora DESC);

-- Trigger Encadenamiento SHA-256 Custodia (Usa hash con mayor secuencia)
CREATE OR REPLACE FUNCTION fn_encadenar_hash_custodia()
RETURNS TRIGGER AS $$
DECLARE
    v_prev_hash VARCHAR(64);
    v_next_seq BIGINT;
    v_fecha_iso TEXT;
    v_lock_id CONSTANT BIGINT := 9876543211;
BEGIN
    PERFORM pg_advisory_xact_lock(v_lock_id);

    SELECT secuencia, hash_sha256_actual INTO v_next_seq, v_prev_hash
    FROM historial_estado_custodia
    ORDER BY secuencia DESC
    LIMIT 1;

    IF v_next_seq IS NULL THEN
        NEW.secuencia := 1;
        v_prev_hash := '0000000000000000000000000000000000000000000000000000000000000000';
    ELSE
        NEW.secuencia := v_next_seq + 1;
    END IF;

    NEW.hash_sha256_anterior := v_prev_hash;
    v_fecha_iso := to_char(NEW.fecha_hora AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');

    NEW.hash_sha256_actual := encode(
        digest(
            NEW.secuencia::text || '|' ||
            v_prev_hash || '|' ||
            v_fecha_iso || '|' ||
            NEW.id_estudiante::text || '|' ||
            NEW.id_viaje::text || '|' ||
            NEW.estado_origen || '|' ||
            NEW.estado_destino || '|' ||
            NEW.disparador_evento || '|' ||
            COALESCE(NEW.registrado_por_usuario::text, 'SISTEMA'),
            'sha256'
        ),
        'hex'
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_encadenar_hash_custodia ON historial_estado_custodia;
CREATE TRIGGER trg_encadenar_hash_custodia
BEFORE INSERT ON historial_estado_custodia
FOR EACH ROW EXECUTE FUNCTION fn_encadenar_hash_custodia();

-- Verificador de Integridad de Custodia
CREATE OR REPLACE FUNCTION fn_verificar_integridad_custodia(p_limite INT DEFAULT 10000)
RETURNS TABLE (
    p_secuencia BIGINT,
    es_valido BOOLEAN,
    hash_esperado VARCHAR,
    hash_encontrado VARCHAR
) AS $$
DECLARE
    r RECORD;
    v_calculated_hash VARCHAR(64);
    v_prev_hash VARCHAR(64) := '0000000000000000000000000000000000000000000000000000000000000000';
    v_fecha_iso TEXT;
BEGIN
    FOR r IN (SELECT * FROM historial_estado_custodia ORDER BY secuencia ASC LIMIT p_limite) LOOP
        v_fecha_iso := to_char(r.fecha_hora AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
        v_calculated_hash := encode(
            digest(
                r.secuencia::text || '|' ||
                v_prev_hash || '|' ||
                v_fecha_iso || '|' ||
                r.id_estudiante::text || '|' ||
                r.id_viaje::text || '|' ||
                r.estado_origen || '|' ||
                r.estado_destino || '|' ||
                r.disparador_evento || '|' ||
                COALESCE(r.registrado_por_usuario::text, 'SISTEMA'),
                'sha256'
            ),
            'hex'
        );

        p_secuencia := r.secuencia;
        hash_esperado := v_calculated_hash;
        hash_encontrado := r.hash_sha256_actual;
        es_valido := (v_calculated_hash = r.hash_sha256_actual AND r.hash_sha256_anterior = v_prev_hash);
        v_prev_hash := r.hash_sha256_actual;
        RETURN NEXT;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- FUNCIÓN: GENERAR MANIFIESTO DE VIAJE (CARGA INICIAL Y REINICIO DIARIO)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_generar_manifiesto_viaje(p_id_viaje UUID)
RETURNS INT AS $$
DECLARE
    v_id_ruta UUID;
    v_insertados INT := 0;
BEGIN
    SELECT id_ruta INTO v_id_ruta FROM viaje WHERE id_viaje = p_id_viaje;
    IF v_id_ruta IS NULL THEN
        RETURN 0;
    END IF;

    -- Insertar estudiantes con asignación activa a la ruta
    INSERT INTO viaje_estudiante (id_viaje, id_estudiante, estado_custodia, es_pasajero_ocasional)
    SELECT 
        p_id_viaje,
        ar.id_estudiante,
        CASE 
            WHEN i.id_inasistencia IS NOT NULL THEN 'AUSENTE_CONFIRMADO'
            ELSE 'EN_CASA_ESPERA'
        END,
        FALSE
    FROM asignacion_ruta ar
    LEFT JOIN inasistencia i ON i.id_viaje = p_id_viaje AND i.id_estudiante = ar.id_estudiante
    WHERE ar.id_ruta = v_id_ruta AND ar.activa = TRUE
    ON CONFLICT (id_viaje, id_estudiante) DO NOTHING;

    GET DIAGNOSTICS v_insertados = ROW_COUNT;
    RETURN v_insertados;
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- FUNCIONES TRANSACCIONALES CON CÓDIGOS DE RESULTADO Y REGISTRO DE INCIDENTES
-- (NO LANZAN EXCEPCIÓN ANTE REGLAS DE NEGOCIO PARA AUDITORÍA RF-16)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_registrar_abordaje_atomico(
    p_id_viaje UUID,
    p_id_estudiante UUID,
    p_metodo VARCHAR,
    p_coordenada GEOGRAPHY,
    p_id_usuario_monitora UUID,
    p_fecha_hora TIMESTAMPTZ DEFAULT NOW(),
    p_es_offline BOOLEAN DEFAULT FALSE
) RETURNS JSONB AS $$
DECLARE
    v_id_asistencia UUID;
    v_id_monitora UUID;
    v_estado_custodia VARCHAR;
    v_filas_actualizadas INT;
    v_viaje_estado VARCHAR;
BEGIN
    -- 1. Validar Monitora
    SELECT m.id_monitora, v.estado INTO v_id_monitora, v_viaje_estado
    FROM viaje v
    JOIN monitora m ON v.id_monitora = m.id_monitora
    WHERE v.id_viaje = p_id_viaje AND m.id_usuario = p_id_usuario_monitora;

    IF v_id_monitora IS NULL THEN
        INSERT INTO incidente (id_viaje, id_estudiante, tipo_incidente, severidad, descripcion, coordenada, fecha_hora, registrado_por_usuario)
        VALUES (p_id_viaje, p_id_estudiante, 'MONITORA_NO_AUTORIZADA', 'CRITICO', 'Intento de escaneo por usuario no asignado al viaje', p_coordenada, p_fecha_hora, p_id_usuario_monitora);
        RETURN jsonb_build_object('codigo', 'DENEGADO_MONITORA_NO_AUTORIZADA', 'exito', false);
    END IF;

    -- Si no es offline, exigir viaje EN_CURSO
    IF NOT p_es_offline AND v_viaje_estado <> 'EN_CURSO' THEN
        INSERT INTO incidente (id_viaje, id_estudiante, tipo_incidente, severidad, descripcion, coordenada, fecha_hora, registrado_por_usuario)
        VALUES (p_id_viaje, p_id_estudiante, 'VIAJE_NO_EN_CURSO', 'ADVERTENCIA', 'Intento de abordaje en viaje no iniciado o finalizado', p_coordenada, p_fecha_hora, p_id_usuario_monitora);
        RETURN jsonb_build_object('codigo', 'DENEGADO_VIAJE_NO_EN_CURSO', 'exito', false);
    END IF;

    -- 2. Bloqueo FOR UPDATE
    SELECT estado_custodia INTO v_estado_custodia
    FROM viaje_estudiante
    WHERE id_viaje = p_id_viaje AND id_estudiante = p_id_estudiante
    FOR UPDATE;

    IF v_estado_custodia IS NULL THEN
        INSERT INTO incidente (id_viaje, id_estudiante, tipo_incidente, severidad, descripcion, coordenada, fecha_hora, registrado_por_usuario)
        VALUES (p_id_viaje, p_id_estudiante, 'ESTUDIANTE_NO_MATRICULADO', 'ADVERTENCIA', 'Menor no pertenece a la ruta del viaje', p_coordenada, p_fecha_hora, p_id_usuario_monitora);
        RETURN jsonb_build_object('codigo', 'DENEGADO_NO_MATRICULADO', 'exito', false);
    END IF;

    IF v_estado_custodia <> 'EN_CASA_ESPERA' THEN
        INSERT INTO incidente (id_viaje, id_estudiante, tipo_incidente, severidad, descripcion, coordenada, fecha_hora, registrado_por_usuario)
        VALUES (p_id_viaje, p_id_estudiante, 'TRANSICION_ESTADO_INVALIDA', 'ADVERTENCIA', 'Menor no se encuentra en EN_CASA_ESPERA (actual: ' || v_estado_custodia || ')', p_coordenada, p_fecha_hora, p_id_usuario_monitora);
        RETURN jsonb_build_object('codigo', 'DENEGADO_ESTADO_INVALIDO', 'exito', false);
    END IF;

    -- 3. Contador Atómico de Aforo (Anti-Sobrecupo RN-02)
    UPDATE viaje
    SET total_a_bordo = total_a_bordo + 1
    WHERE id_viaje = p_id_viaje
      AND total_a_bordo < (
          SELECT v.capacidad_nominal
          FROM vehiculo v
          WHERE v.id_vehiculo = viaje.id_vehiculo
      );

    GET DIAGNOSTICS v_filas_actualizadas = ROW_COUNT;
    IF v_filas_actualizadas = 0 THEN
        INSERT INTO incidente (id_viaje, id_estudiante, tipo_incidente, severidad, descripcion, coordenada, fecha_hora, registrado_por_usuario)
        VALUES (p_id_viaje, p_id_estudiante, 'SOBRECUPO_BLOQUEADO', 'CRITICO', 'Capacidad nominal agotada en vehículo. Abordaje denegado.', p_coordenada, p_fecha_hora, p_id_usuario_monitora);
        RETURN jsonb_build_object('codigo', 'DENEGADO_SOBRECUPO', 'exito', false);
    END IF;

    -- 4. Registrar Asistencia
    v_id_asistencia := fn_uuid_generate_v7();
    INSERT INTO registro_de_asistencia (
        id_asistencia, id_viaje, id_estudiante, tipo_evento, metodo_validacion, coordenada, fecha_hora, sincronizado_offline
    ) VALUES (
        v_id_asistencia, p_id_viaje, p_id_estudiante, 'ABORDAJE', p_metodo, p_coordenada, p_fecha_hora, p_es_offline
    );

    -- 5. Historial Inmutable y Estado de Custodia
    INSERT INTO historial_estado_custodia (
        id_estudiante, id_viaje, estado_origen, estado_destino, disparador_evento, coordenadas_gps, fecha_hora, registrado_por_usuario
    ) VALUES (
        p_id_estudiante, p_id_viaje, 'EN_CASA_ESPERA', 'A_BORDO_VEHICULO', 'ESCANEO_QR_ABORDAJE', p_coordenada, p_fecha_hora, p_id_usuario_monitora
    );

    UPDATE viaje_estudiante
    SET estado_custodia = 'A_BORDO_VEHICULO',
        hora_abordaje = p_fecha_hora,
        actualizado_en = NOW()
    WHERE id_viaje = p_id_viaje AND id_estudiante = p_id_estudiante;

    RETURN jsonb_build_object('codigo', 'EXITO_ABORDAJE', 'exito', true, 'id_asistencia', v_id_asistencia);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_registrar_descenso_atomico(
    p_id_viaje UUID,
    p_id_estudiante UUID,
    p_tipo_receptor VARCHAR,
    p_id_acudiente UUID,
    p_id_autorizado UUID,
    p_estado_entrega VARCHAR,
    p_foto_url TEXT,
    p_coordenada GEOGRAPHY,
    p_observaciones TEXT,
    p_id_usuario_monitora UUID,
    p_fecha_hora TIMESTAMPTZ DEFAULT NOW()
) RETURNS JSONB AS $$
DECLARE
    v_id_entrega UUID;
    v_estado_custodia VARCHAR;
    v_receptor_blind_index VARCHAR(64);
    v_filas_actualizadas INT;
    v_secuencia_intento INT;
BEGIN
    -- 1. Bloqueo FOR UPDATE
    SELECT estado_custodia INTO v_estado_custodia
    FROM viaje_estudiante
    WHERE id_viaje = p_id_viaje AND id_estudiante = p_id_estudiante
    FOR UPDATE;

    -- Uso de IS DISTINCT FROM para robustez ante nulos
    IF v_estado_custodia IS DISTINCT FROM 'A_BORDO_VEHICULO' THEN
        INSERT INTO incidente (id_viaje, id_estudiante, tipo_incidente, severidad, descripcion, coordenada, fecha_hora, registrado_por_usuario)
        VALUES (p_id_viaje, p_id_estudiante, 'TRANSICION_DESCENSO_INVALIDA', 'ADVERTENCIA', 'Estudiante no figura A_BORDO_VEHICULO', p_coordenada, p_fecha_hora, p_id_usuario_monitora);
        RETURN jsonb_build_object('codigo', 'DENEGADO_NO_A_BORDO', 'exito', false);
    END IF;

    -- 2. Calcular secuencia de intento (soporte para RF-08)
    SELECT COALESCE(MAX(intento_secuencia), 0) + 1 INTO v_secuencia_intento
    FROM entrega WHERE id_viaje = p_id_viaje AND id_estudiante = p_id_estudiante;

    -- 3. Si es Entrega Exitosa: Validar Autorizado Activo y Bloqueo de Alerta Judicial
    IF p_estado_entrega = 'ENTREGADO_EXITOSO' THEN
        IF p_tipo_receptor = 'AUTORIZADO' THEN
            IF NOT EXISTS (
                SELECT 1 FROM estudiante_autorizado
                WHERE id_estudiante = p_id_estudiante 
                  AND id_autorizado = p_id_autorizado
                  AND activo = TRUE
                  AND (autorizado_hasta IS NULL OR autorizado_hasta > NOW())
            ) THEN
                INSERT INTO incidente (id_viaje, id_estudiante, tipo_incidente, severidad, descripcion, coordenada, fecha_hora, registrado_por_usuario)
                VALUES (p_id_viaje, p_id_estudiante, 'AUTORIZADO_INACTIVO_O_VENCIDO', 'CRITICO', 'Adulto receptor no tiene autorización vigente', p_coordenada, p_fecha_hora, p_id_usuario_monitora);
                RETURN jsonb_build_object('codigo', 'DENEGADO_AUTORIZADO_INVALIDO', 'exito', false);
            END IF;

            SELECT documento_blind_index INTO v_receptor_blind_index FROM adulto_autorizado WHERE id_autorizado = p_id_autorizado;
        ELSIF p_tipo_receptor = 'ACUDIENTE' THEN
            SELECT documento_blind_index INTO v_receptor_blind_index FROM acudiente WHERE id_acudiente = p_id_acudiente;
        END IF;

        -- BLOQUEO DE ALERTA JUDICIAL EN LA ENTREGA (SRS RF-07, RN-04)
        IF EXISTS (
            SELECT 1 FROM alerta_judicial
            WHERE id_estudiante = p_id_estudiante AND activa = TRUE AND individuo_blind_index = v_receptor_blind_index
        ) THEN
            INSERT INTO incidente (id_viaje, id_estudiante, tipo_incidente, severidad, descripcion, coordenada, fecha_hora, registrado_por_usuario)
            VALUES (p_id_viaje, p_id_estudiante, 'ALERTA_JUDICIAL_ROJA_BLOQUEO', 'CRITICO', 'Individuo receptor con orden judicial restrictiva. Entrega bloqueada.', p_coordenada, p_fecha_hora, p_id_usuario_monitora);
            
            -- Activar automáticamente protocolo de retorno
            RETURN jsonb_build_object('codigo', 'ALERTA_JUDICIAL_BLOQUEANTE', 'exito', false);
        END IF;

        -- Decrementar total_a_bordo verificando exactamente 1 fila afectada
        UPDATE viaje SET total_a_bordo = total_a_bordo - 1 WHERE id_viaje = p_id_viaje AND total_a_bordo > 0;
        GET DIAGNOSTICS v_filas_actualizadas = ROW_COUNT;
        IF v_filas_actualizadas <> 1 THEN
            RAISE EXCEPTION 'ERROR DE INTEGRIDAD: Fallo al decrementar aforo.';
        END IF;

        INSERT INTO registro_de_asistencia (
            id_asistencia, id_viaje, id_estudiante, tipo_evento, metodo_validacion, coordenada, fecha_hora
        ) VALUES (
            fn_uuid_generate_v7(), p_id_viaje, p_id_estudiante, 'DESCENSO', 'VERIFICACION_VISUAL_PARADA', p_coordenada, p_fecha_hora
        );

        UPDATE viaje_estudiante
        SET estado_custodia = 'ENTREGADO_ADULTO_AUTORIZADO',
            hora_desembarque = p_fecha_hora,
            actualizado_en = NOW()
        WHERE id_viaje = p_id_viaje AND id_estudiante = p_id_estudiante;

        INSERT INTO historial_estado_custodia (
            id_estudiante, id_viaje, estado_origen, estado_destino, disparador_evento, coordenadas_gps, fecha_hora, registrado_por_usuario
        ) VALUES (
            p_id_estudiante, p_id_viaje, 'A_BORDO_VEHICULO', 'ENTREGADO_ADULTO_AUTORIZADO', 'ENTREGA_VALIDADA_PARADA', p_coordenada, p_fecha_hora, p_id_usuario_monitora
        );
    ELSE
        -- Desembarque Fallido (SRS RF-08): Menor continúa a bordo (NO se decrementa aforo ni se registra DESCENSO)
        UPDATE viaje_estudiante
        SET estado_custodia = 'RETORNO_SEGURO_SEDE', actualizado_en = NOW()
        WHERE id_viaje = p_id_viaje AND id_estudiante = p_id_estudiante;

        INSERT INTO historial_estado_custodia (
            id_estudiante, id_viaje, estado_origen, estado_destino, disparador_evento, coordenadas_gps, fecha_hora, registrado_por_usuario
        ) VALUES (
            p_id_estudiante, p_id_viaje, 'A_BORDO_VEHICULO', 'RETORNO_SEGURO_SEDE', 'RECEPTOR_AUSENTE_FALLIDO', p_coordenada, p_fecha_hora, p_id_usuario_monitora
        );

        INSERT INTO incidente (id_viaje, id_estudiante, tipo_incidente, severidad, descripcion, coordenada, fecha_hora, registrado_por_usuario)
        VALUES (p_id_viaje, p_id_estudiante, 'DESEMBARQUE_FALLIDO', 'CRITICO', 'Adulto ausente en parada tras 3 minutos de cortesía.', p_coordenada, p_fecha_hora, p_id_usuario_monitora);
    END IF;

    v_id_entrega := fn_uuid_generate_v7();
    INSERT INTO entrega (
        id_entrega, id_viaje, id_estudiante, intento_secuencia, tipo_receptor, id_acudiente, id_autorizado,
        estado_entrega, foto_evidencia_url, coordenada, observaciones_fallido, fecha_hora
    ) VALUES (
        v_id_entrega, p_id_viaje, p_id_estudiante, v_secuencia_intento, p_tipo_receptor, p_id_acudiente, p_id_autorizado,
        p_estado_entrega, p_foto_url, p_coordenada, p_observaciones, p_fecha_hora
    );

    RETURN jsonb_build_object('codigo', 'EXITO_ENTREGA', 'exito', true, 'id_entrega', v_id_entrega);
END;
$$ LANGUAGE plpgsql;

-- Finalización de Retorno Seguro en Sede Institucional (Acta de Custodia)
CREATE OR REPLACE FUNCTION fn_finalizar_custodia_sede(
    p_id_viaje UUID,
    p_id_estudiante UUID,
    p_id_entrega_fallida UUID,
    p_id_usuario_coordinador UUID,
    p_firma_digital TEXT,
    p_coordenada GEOGRAPHY,
    p_observaciones TEXT DEFAULT 'Entrega formal en sede escolar tras retorno seguro',
    p_fecha_hora TIMESTAMPTZ DEFAULT NOW()
) RETURNS UUID AS $$
DECLARE
    v_id_coordinador UUID;
    v_id_acta UUID;
    v_estado_custodia VARCHAR;
BEGIN
    SELECT id_coordinador INTO v_id_coordinador
    FROM coordinador WHERE id_usuario = p_id_usuario_coordinador;

    IF v_id_coordinador IS NULL THEN
        RAISE EXCEPTION 'DENEGACIÓN: Solo la Coordinación puede recibir formalmente a un menor en sede.';
    END IF;

    SELECT estado_custodia INTO v_estado_custodia
    FROM viaje_estudiante WHERE id_viaje = p_id_viaje AND id_estudiante = p_id_estudiante
    FOR UPDATE;

    IF v_estado_custodia IS DISTINCT FROM 'RETORNO_SEGURO_SEDE' THEN
        RAISE EXCEPTION 'TRANSICIÓN ILEGAL: El menor no se encuentra en estado RETORNO_SEGURO_SEDE.';
    END IF;

    -- Aquí SÍ se decrementa el aforo vehicular del viaje
    UPDATE viaje SET total_a_bordo = total_a_bordo - 1 WHERE id_viaje = p_id_viaje;

    INSERT INTO registro_de_asistencia (
        id_asistencia, id_viaje, id_estudiante, tipo_evento, metodo_validacion, coordenada, fecha_hora
    ) VALUES (
        fn_uuid_generate_v7(), p_id_viaje, p_id_estudiante, 'DESCENSO', 'VERIFICACION_VISUAL_PARADA', p_coordenada, p_fecha_hora
    );

    UPDATE viaje_estudiante
    SET estado_custodia = 'EN_CUSTODIA_INSTITUCIONAL',
        hora_desembarque = p_fecha_hora,
        actualizado_en = NOW()
    WHERE id_viaje = p_id_viaje AND id_estudiante = p_id_estudiante;

    INSERT INTO historial_estado_custodia (
        id_estudiante, id_viaje, estado_origen, estado_destino, disparador_evento, coordenadas_gps, fecha_hora, registrado_por_usuario
    ) VALUES (
        p_id_estudiante, p_id_viaje, 'RETORNO_SEGURO_SEDE', 'EN_CUSTODIA_INSTITUCIONAL', 'ACTA_RECEPCION_COORDINACION', p_coordenada, p_fecha_hora, p_id_usuario_coordinador
    );

    v_id_acta := fn_uuid_generate_v7();
    INSERT INTO acta_custodia (
        id_acta, id_entrega, id_estudiante, recibido_por_coordinador, fecha_recepcion, firma_digital_hash, observaciones
    ) VALUES (
        v_id_acta, p_id_entrega_fallida, p_id_estudiante, v_id_coordinador, p_fecha_hora, p_firma_digital, p_observaciones
    );

    RETURN v_id_acta;
END;
$$ LANGUAGE plpgsql;

COMMIT;
