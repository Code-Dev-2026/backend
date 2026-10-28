-- ============================================================================
-- MIGRACIÓN V003: ESTUDIANTES, BÓVEDA BIOMÉTRICA DE AUTORIZADOS Y ALERTAS JUDICIALES
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS estudiante (
    id_estudiante UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_colegio UUID NOT NULL REFERENCES colegio(id_colegio) ON DELETE RESTRICT,
    codigo_institucional VARCHAR(30) NOT NULL UNIQUE,
    -- Datos del Menor: Cifrado en Reposo Formato key_version:iv:tag:ciphertext (Ley 1581)
    -- NOTA: Se elimina la foto del estudiante por principio de minimización de datos
    documento_cifrado formato_cifrado_aes NOT NULL,
    documento_blind_index VARCHAR(64) NOT NULL UNIQUE, -- HMAC-SHA256
    nombres_cifrado formato_cifrado_aes NOT NULL,
    apellidos_cifrado formato_cifrado_aes NOT NULL,
    fecha_nacimiento_cifrada formato_cifrado_aes NOT NULL,
    grado VARCHAR(20) NOT NULL,
    qr_token_hash VARCHAR(64) NOT NULL UNIQUE,
    domicilio_punto GEOGRAPHY(Point, 4326) NOT NULL, -- Domicilio para ruteo (RF-01, RF-17)
    activo BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_estudiante_blind_index ON estudiante(documento_blind_index);
CREATE INDEX IF NOT EXISTS idx_estudiante_domicilio ON estudiante USING GIST (domicilio_punto);

CREATE TABLE IF NOT EXISTS estudiante_acudiente (
    id_estudiante UUID NOT NULL REFERENCES estudiante(id_estudiante) ON DELETE CASCADE,
    id_acudiente UUID NOT NULL REFERENCES acudiente(id_acudiente) ON DELETE CASCADE,
    parentesco VARCHAR(30) NOT NULL,
    es_tutor_principal BOOLEAN NOT NULL DEFAULT FALSE,
    orden_notificacion INT NOT NULL DEFAULT 1,
    PRIMARY KEY (id_estudiante, id_acudiente)
);

CREATE TABLE IF NOT EXISTS estudiante_autorizado (
    id_estudiante UUID NOT NULL REFERENCES estudiante(id_estudiante) ON DELETE CASCADE,
    id_autorizado UUID NOT NULL REFERENCES adulto_autorizado(id_autorizado) ON DELETE RESTRICT,
    autorizado_por UUID NOT NULL, -- Acudiente que expide la legitimación
    parentesco VARCHAR(30) NOT NULL,
    prioridad_retiro INT NOT NULL DEFAULT 1,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    autorizado_hasta TIMESTAMPTZ,
    PRIMARY KEY (id_estudiante, id_autorizado),
    -- FK compuesto: Garantiza que solo un acudiente vinculado legalmente al menor puede autorizar
    CONSTRAINT fk_autorizado_por_tutor 
        FOREIGN KEY (id_estudiante, autorizado_por) 
        REFERENCES estudiante_acudiente(id_estudiante, id_acudiente) ON DELETE RESTRICT
);

-- REGLA SRS RF-05: Máximo 3 Autorizados Activos con Bloqueo FOR UPDATE
CREATE OR REPLACE FUNCTION fn_check_max_tres_autorizados()
RETURNS TRIGGER AS $$
DECLARE
    v_total INT;
BEGIN
    -- Bloqueo pesimista del registro del estudiante para evitar condiciones de carrera concurrentes
    PERFORM 1 FROM estudiante WHERE id_estudiante = NEW.id_estudiante FOR UPDATE;

    SELECT COUNT(*) INTO v_total
    FROM estudiante_autorizado
    WHERE id_estudiante = NEW.id_estudiante 
      AND activo = TRUE
      AND (TG_OP = 'INSERT' OR id_autorizado <> OLD.id_autorizado);

    IF NEW.activo = TRUE AND v_total >= 3 THEN
        RAISE EXCEPTION 'RESTRICCIÓN SRS RF-05: Cupo máximo excedido. Un menor solo puede tener hasta 3 adultos autorizados activos.'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_limite_autorizados ON estudiante_autorizado;
CREATE TRIGGER trg_limite_autorizados
BEFORE INSERT OR UPDATE OF activo ON estudiante_autorizado
FOR EACH ROW EXECUTE FUNCTION fn_check_max_tres_autorizados();

-- Bóveda Biométrica POR ADULTO AUTORIZADO (RF-05, HU-06)
CREATE TABLE IF NOT EXISTS expediente_cifrado (
    id_expediente UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_autorizado UUID NOT NULL UNIQUE REFERENCES adulto_autorizado(id_autorizado) ON DELETE CASCADE,
    consentimiento_firmado_por_acudiente UUID NOT NULL REFERENCES acudiente(id_acudiente) ON DELETE RESTRICT,
    foto_rostro_cifrada formato_cifrado_aes NOT NULL,
    foto_cedula_cifrada formato_cifrado_aes NOT NULL,
    consentimiento_ley1581_pdf_url TEXT NOT NULL,
    fecha_consentimiento TIMESTAMPTZ NOT NULL,
    verificado_por_coordinacion BOOLEAN NOT NULL DEFAULT FALSE,
    verificado_por_coordinador UUID REFERENCES coordinador(id_coordinador) ON DELETE RESTRICT,
    fecha_verificacion TIMESTAMPTZ,
    revocado BOOLEAN NOT NULL DEFAULT FALSE,
    hash_integridad_sha256 VARCHAR(64) NOT NULL,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Alertas Judiciales Registradas por Rectoría (RF-07, HU-07, RN-04, RNF-08)
CREATE TABLE IF NOT EXISTS alerta_judicial (
    id_alerta UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_estudiante UUID NOT NULL REFERENCES estudiante(id_estudiante) ON DELETE CASCADE,
    juzgado_emisor VARCHAR(150) NOT NULL,
    radicado_medida VARCHAR(50) NOT NULL UNIQUE,
    foto_individuo_cifrada formato_cifrado_aes NOT NULL, -- Imagen para cotejo en parada
    individuo_restringido_nombre_cifrado formato_cifrado_aes NOT NULL,
    individuo_restringido_documento_cifrado formato_cifrado_aes NOT NULL,
    individuo_blind_index VARCHAR(64) NOT NULL, -- HMAC-SHA256
    orden_judicial_resumen_cifrado formato_cifrado_aes NOT NULL,
    activa BOOLEAN NOT NULL DEFAULT TRUE,
    fecha_registro TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    registrado_por_rectoria UUID NOT NULL REFERENCES usuario(id_usuario) ON DELETE RESTRICT,
    -- Auditoría de Modificación / Soft-Delete (Solo Coordinadora con Aval)
    eliminado_soft BOOLEAN NOT NULL DEFAULT FALSE,
    eliminado_en TIMESTAMPTZ,
    eliminado_por_coordinacion UUID REFERENCES coordinador(id_coordinador) ON DELETE RESTRICT,
    autorizado_excepcion_por VARCHAR(100), -- Policía de Infancia o delegación formal Rectoría
    hash_integridad_sha256 VARCHAR(64) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerta_blind_index ON alerta_judicial(individuo_blind_index);

COMMIT;
