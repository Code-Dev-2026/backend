-- ============================================================================
-- CAMINO SEGURO - MOTOR CORE & CUSTODIA (COLEGIO SAN BENITO DEL OTÚN)
-- V008__forensic_audit_trail.sql
-- Sub-sistemas: Bitácora Forense Criptográfica Encadenada (SHA-256),
--               Inmutabilidad Estricta y Verificador de Integridad
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. TABLA DE BITÁCORA DE AUDITORÍA FORENSE
-- RF-16, RNF-01, RNF-03, OWASP ASVS V1.14
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bitacora_auditoria (
    id_auditoria UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    secuencia BIGINT NOT NULL,
    tabla VARCHAR(60) NOT NULL,
    operacion VARCHAR(10) NOT NULL CHECK (operacion IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
    registro_id UUID,
    usuario_id UUID,
    ip_origen INET,
    user_agent TEXT,
    datos_anteriores JSONB,
    datos_nuevos JSONB,
    fecha_hora TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    hash_sha256_anterior VARCHAR(64) NOT NULL,
    hash_sha256_actual VARCHAR(64) NOT NULL,
    CONSTRAINT unq_bitacora_secuencia UNIQUE (secuencia)
);

CREATE INDEX IF NOT EXISTS idx_bitacora_tabla_fecha ON bitacora_auditoria(tabla, fecha_hora DESC);
CREATE INDEX IF NOT EXISTS idx_bitacora_registro_id ON bitacora_auditoria(registro_id);

-- ----------------------------------------------------------------------------
-- 2. TRIGGER DE INMUTABILIDAD EN BITÁCORA
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_bloquear_modificacion_bitacora()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'VIOLACION DE SEGURIDAD ASVS L2: La tabla bitacora_auditoria es estrictamente inmutable (WORM). No se permite UPDATE, DELETE ni TRUNCATE.';
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER trg_bitacora_inmutable_upd_del
BEFORE UPDATE OR DELETE ON bitacora_auditoria
FOR EACH ROW EXECUTE FUNCTION fn_bloquear_modificacion_bitacora();

CREATE OR REPLACE TRIGGER trg_bitacora_inmutable_truncate
BEFORE TRUNCATE ON bitacora_auditoria
FOR EACH STATEMENT EXECUTE FUNCTION fn_bloquear_modificacion_bitacora();

-- ----------------------------------------------------------------------------
-- 3. TRIGGER DE ENCADENAMIENTO CRIPTOGRÁFICO DE AUDITORÍA
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_trg_encadenar_bitacora()
RETURNS TRIGGER AS $$
DECLARE
    v_prev_hash VARCHAR(64);
    v_next_secuencia BIGINT;
    v_fecha_utc_iso TEXT;
    v_payload_cadena TEXT;
    c_genesis_hash CONSTANT VARCHAR(64) := '0000000000000000000000000000000000000000000000000000000000000000';
    c_lock_id CONSTANT BIGINT := 9876543210;
BEGIN
    -- 1. Candado consultivo de transacción para serializar inserciones
    PERFORM pg_advisory_xact_lock(c_lock_id);

    -- 2. Asignar secuencia incremental y obtener el último hash
    SELECT secuencia, hash_sha256_actual
    INTO v_next_secuencia, v_prev_hash
    FROM bitacora_auditoria
    ORDER BY secuencia DESC
    LIMIT 1;

    IF v_next_secuencia IS NULL THEN
        NEW.secuencia := 1;
        NEW.hash_sha256_anterior := c_genesis_hash;
    ELSE
        NEW.secuencia := v_next_secuencia + 1;
        NEW.hash_sha256_anterior := v_prev_hash;
    END IF;

    -- 3. Formato ISO UTC estricto con microsegundos
    NEW.fecha_hora := COALESCE(NEW.fecha_hora, clock_timestamp());
    v_fecha_utc_iso := to_char(NEW.fecha_hora AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');

    -- 4. Construcción determinista con separador '|'
    v_payload_cadena := NEW.secuencia::text || '|' ||
                        NEW.tabla || '|' ||
                        NEW.operacion || '|' ||
                        COALESCE(NEW.registro_id::text, '') || '|' ||
                        COALESCE(NEW.usuario_id::text, '') || '|' ||
                        v_fecha_utc_iso || '|' ||
                        COALESCE(NEW.datos_anteriores::text, '{}') || '|' ||
                        COALESCE(NEW.datos_nuevos::text, '{}') || '|' ||
                        NEW.hash_sha256_anterior;

    NEW.hash_sha256_actual := encode(digest(v_payload_cadena, 'sha256'), 'hex');

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER trg_bitacora_encadenar_hash
BEFORE INSERT ON bitacora_auditoria
FOR EACH ROW EXECUTE FUNCTION fn_trg_encadenar_bitacora();

-- ----------------------------------------------------------------------------
-- 4. FUNCIÓN VERIFICADORA DE INTEGRIDAD DE LA CADENA DE AUDITORÍA
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_verificar_integridad_bitacora(p_limite INT DEFAULT 5000)
RETURNS TABLE (
    total_verificados BIGINT,
    cadena_integra BOOLEAN,
    secuencia_fallo BIGINT,
    motivo_fallo TEXT
) AS $$
DECLARE
    r RECORD;
    v_recalculado VARCHAR(64);
    v_hash_esperado_anterior VARCHAR(64) := '0000000000000000000000000000000000000000000000000000000000000000';
    v_fecha_utc_iso TEXT;
    v_payload_cadena TEXT;
    v_contador BIGINT := 0;
BEGIN
    FOR r IN (SELECT * FROM bitacora_auditoria ORDER BY secuencia ASC LIMIT p_limite)
    LOOP
        v_contador := v_contador + 1;

        -- Verificar enlace con el bloque previo
        IF r.hash_sha256_anterior <> v_hash_esperado_anterior THEN
            RETURN QUERY SELECT v_contador, false, r.secuencia,
                format('Ruptura de enlace hash previo. Esperado: %s, Hallado: %s', v_hash_esperado_anterior, r.hash_sha256_anterior);
            RETURN;
        END IF;

        -- Recalcular hash actual
        v_fecha_utc_iso := to_char(r.fecha_hora AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
        v_payload_cadena := r.secuencia::text || '|' ||
                            r.tabla || '|' ||
                            r.operacion || '|' ||
                            COALESCE(r.registro_id::text, '') || '|' ||
                            COALESCE(r.usuario_id::text, '') || '|' ||
                            v_fecha_utc_iso || '|' ||
                            COALESCE(r.datos_anteriores::text, '{}') || '|' ||
                            COALESCE(r.datos_nuevos::text, '{}') || '|' ||
                            r.hash_sha256_anterior;

        v_recalculado := encode(digest(v_payload_cadena, 'sha256'), 'hex');

        IF v_recalculado <> r.hash_sha256_actual THEN
            RETURN QUERY SELECT v_contador, false, r.secuencia,
                format('Hash manipulado o corrupto en secuencia %s. Calculado: %s, Almacenado: %s', r.secuencia, v_recalculado, r.hash_sha256_actual);
            RETURN;
        END IF;

        v_hash_esperado_anterior := r.hash_sha256_actual;
    END LOOP;

    RETURN QUERY SELECT v_contador, true, NULL::BIGINT, 'Cadena criptográfica íntegra sin alteraciones'::TEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
