-- ============================================================================
-- CAMINO SEGURO - BACKEND CORE DDL (POSTGRESQL 16 + POSTGIS 3.4)
-- Archivo: V006__attendance_and_custody_lifecycle.sql
-- Subdominio: Control de Custodia, Asistencia QR, Entregas Verificadas y Cadena Forense
-- Requisitos SRS: RF-02, RF-03, RF-06, RF-08, RF-13, RF-16, RN-01, RN-04, RNF-05, RNF-08
-- Tablas creadas: 6
-- ============================================================================

BEGIN;

-- 29. AUTORIZACIÓN SUPERIOR Y AVAL DIRECTIVO (RF-08, RF-13, RF-16)
CREATE TABLE IF NOT EXISTS aval_coordinacion (
    id_aval UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_viaje UUID NOT NULL REFERENCES viaje(id_viaje) ON DELETE RESTRICT,
    avalado_por_coordinador UUID NOT NULL REFERENCES coordinador(id_coordinador) ON DELETE RESTRICT,
    tipo_aval VARCHAR(50) NOT NULL
        CHECK (tipo_aval IN ('TRANSBORDO_EMERGENCIA', 'CAMBIO_CHOFER', 'EXCEPCION_ENTREGA_SIGUIENTE_PARADA', 'DESVIO_OPERATIVO_JUSTIFICADO')),
    justificativa TEXT NOT NULL,
    fecha_aval TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_aval_viaje ON aval_coordinacion(id_viaje);

-- 30. INCIDENTES Y REGISTRO DE ANOMALÍAS OPERATIVAS (RF-16)
CREATE TABLE IF NOT EXISTS incidente (
    id_incidente UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_viaje UUID NOT NULL REFERENCES viaje(id_viaje) ON DELETE RESTRICT,
    id_estudiante UUID REFERENCES estudiante(id_estudiante) ON DELETE SET NULL,
    tipo_incidente VARCHAR(50) NOT NULL,
    severidad VARCHAR(20) NOT NULL CHECK (severidad IN ('INFORMATIVO', 'ADVERTENCIA', 'CRITICO')),
    descripcion TEXT NOT NULL,
    coordenada GEOGRAPHY(Point, 4326),
    fecha_hora TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    registrado_por_usuario UUID REFERENCES usuario(id_usuario) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_incidente_viaje ON incidente(id_viaje, severidad);
CREATE INDEX IF NOT EXISTS idx_incidente_estudiante ON incidente(id_estudiante);
CREATE INDEX IF NOT EXISTS idx_incidente_coordenada ON incidente USING GIST (coordenada);

-- 31. REGISTRO TRANSACCIONAL DE ASISTENCIA (ABORDAJE Y DESCENSO)
CREATE TABLE IF NOT EXISTS registro_de_asistencia (
    id_asistencia UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_viaje UUID NOT NULL REFERENCES viaje(id_viaje) ON DELETE RESTRICT,
    id_estudiante UUID NOT NULL REFERENCES estudiante(id_estudiante) ON DELETE RESTRICT,
    tipo_evento VARCHAR(20) NOT NULL CHECK (tipo_evento IN ('ABORDAJE', 'DESCENSO')),
    metodo_validacion VARCHAR(30) NOT NULL
        CHECK (metodo_validacion IN ('QR_INSTITUCIONAL', 'QR_OCASIONAL_TEMPORAL', 'VERIFICACION_VISUAL_PARADA')),
    coordenada GEOGRAPHY(Point, 4326) NOT NULL,
    fecha_hora TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    sincronizado_offline BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT uq_asistencia_viaje_evento UNIQUE (id_viaje, id_estudiante, tipo_evento)
);
CREATE INDEX IF NOT EXISTS idx_asistencia_coordenada ON registro_de_asistencia USING GIST (coordenada);
CREATE INDEX IF NOT EXISTS idx_asistencia_estudiante ON registro_de_asistencia(id_estudiante);

-- 32. FORMALIZACIÓN DE ENTREGA EN PARADA (RF-06, RF-08, RN-04)
CREATE TABLE IF NOT EXISTS entrega (
    id_entrega UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_viaje UUID NOT NULL REFERENCES viaje(id_viaje) ON DELETE RESTRICT,
    id_estudiante UUID NOT NULL REFERENCES estudiante(id_estudiante) ON DELETE RESTRICT,
    intento_secuencia INT NOT NULL DEFAULT 1,
    tipo_receptor VARCHAR(30) NOT NULL CHECK (tipo_receptor IN ('ACUDIENTE', 'AUTORIZADO', 'RETORNO_SEDE_ESCOLAR')),
    id_acudiente UUID,
    id_autorizado UUID,
    estado_entrega VARCHAR(30) NOT NULL CHECK (estado_entrega IN ('ENTREGADO_EXITOSO', 'DESEMBARQUE_FALLIDO_RETORNO')),
    id_aval_coordinacion UUID REFERENCES aval_coordinacion(id_aval) ON DELETE RESTRICT,
    foto_evidencia_url TEXT,
    coordenada GEOGRAPHY(Point, 4326) NOT NULL,
    observaciones_fallido TEXT,
    fecha_hora TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
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
CREATE INDEX IF NOT EXISTS idx_entrega_estudiante ON entrega(id_estudiante);

-- 33. ACTA DE CUSTODIA EN SEDE INSTITUCIONAL (Entrega Formal a Directivas)
CREATE TABLE IF NOT EXISTS acta_custodia (
    id_acta UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_entrega UUID NOT NULL UNIQUE REFERENCES entrega(id_entrega) ON DELETE RESTRICT,
    id_estudiante UUID NOT NULL REFERENCES estudiante(id_estudiante) ON DELETE RESTRICT,
    recibido_por_coordinador UUID NOT NULL REFERENCES coordinador(id_coordinador) ON DELETE RESTRICT,
    fecha_recepcion TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    firma_digital_hash TEXT NOT NULL,
    observaciones TEXT
);

-- 34. HISTORIAL INMUTABLE DE CUSTODIA CON ENCADENAMIENTO SHA-256
CREATE TABLE IF NOT EXISTS historial_estado_custodia (
    secuencia BIGINT PRIMARY KEY,
    id_historial UUID NOT NULL UNIQUE DEFAULT fn_uuid_generate_v7(),
    id_estudiante UUID NOT NULL REFERENCES estudiante(id_estudiante) ON DELETE RESTRICT,
    id_viaje UUID NOT NULL REFERENCES viaje(id_viaje) ON DELETE RESTRICT,
    estado_origen VARCHAR(30) NOT NULL,
    estado_destino VARCHAR(30) NOT NULL,
    disparador_evento VARCHAR(50) NOT NULL,
    coordenadas_gps GEOGRAPHY(Point, 4326),
    fecha_hora TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    registrado_por_usuario UUID REFERENCES usuario(id_usuario) ON DELETE RESTRICT,
    hash_sha256_anterior VARCHAR(64) NOT NULL,
    hash_sha256_actual VARCHAR(64) NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_historial_estudiante_tiempo ON historial_estado_custodia(id_estudiante, fecha_hora DESC);
CREATE INDEX IF NOT EXISTS idx_historial_viaje ON historial_estado_custodia(id_viaje);
CREATE INDEX IF NOT EXISTS idx_historial_coordenadas ON historial_estado_custodia USING GIST (coordenadas_gps);

-- Trigger de Encadenamiento Criptográfico SHA-256 para Custodia
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

-- Verificador Forense de Integridad de la Cadena de Custodia
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

COMMIT;
