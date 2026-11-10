-- ============================================================================
-- CAMINO SEGURO - BACKEND CORE DDL (POSTGRESQL 16 + POSTGIS 3.4)
-- Archivo: V003__students_and_custody_vault.sql
-- Subdominio: Expediente de Menores, Bóveda Biométrica de Custodia y Alertas Judiciales
-- Requisitos SRS: RF-01, RF-02, RF-05, RF-06, RF-07, RN-04, RNF-01, RNF-08, RNF-09
-- Tablas creadas: 5
-- ============================================================================

BEGIN;

-- 14. EXPEDIENTE PROTEGIDO DEL MENOR (Ley Estatutaria 1581 de 2012 / Minimizacion de Datos)
-- Se eliminan fotos de menores conforme al principio de proporcionalidad y minimización
CREATE TABLE IF NOT EXISTS estudiante (
    id_estudiante UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_colegio UUID NOT NULL REFERENCES colegio(id_colegio) ON DELETE RESTRICT,
    codigo_institucional VARCHAR(30) NOT NULL UNIQUE,
    documento_cifrado formato_cifrado_aes NOT NULL,
    documento_blind_index VARCHAR(64) NOT NULL UNIQUE, -- HMAC-SHA256 para búsqueda determinista
    nombres_cifrado formato_cifrado_aes NOT NULL,
    apellidos_cifrado formato_cifrado_aes NOT NULL,
    fecha_nacimiento_cifrada formato_cifrado_aes NOT NULL,
    grado VARCHAR(20) NOT NULL,
    qr_token_hash VARCHAR(64) NOT NULL UNIQUE,
    domicilio_punto GEOGRAPHY(Point, 4326) NOT NULL, -- Coordenada para optimización de ruteo
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_estudiante_blind_index ON estudiante(documento_blind_index);
CREATE INDEX IF NOT EXISTS idx_estudiante_domicilio ON estudiante USING GIST (domicilio_punto);
CREATE INDEX IF NOT EXISTS idx_estudiante_colegio ON estudiante(id_colegio);

-- 15. RELACIÓN TUTOR - ESTUDIANTE (Custodias Compartidas N:M)
CREATE TABLE IF NOT EXISTS estudiante_acudiente (
    id_estudiante UUID NOT NULL REFERENCES estudiante(id_estudiante) ON DELETE CASCADE,
    id_acudiente UUID NOT NULL REFERENCES acudiente(id_acudiente) ON DELETE CASCADE,
    parentesco VARCHAR(30) NOT NULL,
    es_tutor_principal BOOLEAN NOT NULL DEFAULT FALSE,
    orden_notificacion INT NOT NULL DEFAULT 1,
    asignado_en TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (id_estudiante, id_acudiente)
);
CREATE INDEX IF NOT EXISTS idx_estudiante_acudiente_acudiente ON estudiante_acudiente(id_acudiente);

-- 16. ADULTOS AUTORIZADOS VINCULADOS AL MENOR (Legitimación por tutor)
CREATE TABLE IF NOT EXISTS estudiante_autorizado (
    id_estudiante UUID NOT NULL REFERENCES estudiante(id_estudiante) ON DELETE CASCADE,
    id_autorizado UUID NOT NULL REFERENCES adulto_autorizado(id_autorizado) ON DELETE RESTRICT,
    autorizado_por UUID NOT NULL, -- Acudiente que suscribe formalmente la autorización
    parentesco VARCHAR(30) NOT NULL,
    prioridad_retiro INT NOT NULL DEFAULT 1,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    autorizado_hasta TIMESTAMPTZ,
    asignado_en TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (id_estudiante, id_autorizado),
    -- Clave foránea compuesta que asegura legitimidad del acudiente vinculador
    CONSTRAINT fk_autorizado_por_tutor
        FOREIGN KEY (id_estudiante, autorizado_por)
        REFERENCES estudiante_acudiente(id_estudiante, id_acudiente) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_estudiante_autorizado_autorizado ON estudiante_autorizado(id_autorizado);

-- RESTRICCIÓN SRS RF-05: Máximo 3 Autorizados Activos simultáneos con bloqueo FOR UPDATE
CREATE OR REPLACE FUNCTION fn_check_max_tres_autorizados()
RETURNS TRIGGER AS $$
DECLARE
    v_total INT;
BEGIN
    -- Bloqueo pesimista del expediente del estudiante para serializar escrituras concurrentes
    PERFORM 1 FROM estudiante WHERE id_estudiante = NEW.id_estudiante FOR UPDATE;

    SELECT COUNT(*) INTO v_total
    FROM estudiante_autorizado
    WHERE id_estudiante = NEW.id_estudiante
      AND activo = TRUE
      AND (TG_OP = 'INSERT' OR id_autorizado <> OLD.id_autorizado);

    IF NEW.activo = TRUE AND v_total >= 3 THEN
        RAISE EXCEPTION 'RESTRICCION SRS RF-05: Cupo maximo excedido. Un menor solo puede tener hasta 3 adultos autorizados activos.'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_limite_autorizados ON estudiante_autorizado;
CREATE TRIGGER trg_limite_autorizados
BEFORE INSERT OR UPDATE OF activo ON estudiante_autorizado
FOR EACH ROW EXECUTE FUNCTION fn_check_max_tres_autorizados();

-- 17. BÓVEDA BIOMÉTRICA POR ADULTO AUTORIZADO (RF-05, HU-06, RNF-09)
CREATE TABLE IF NOT EXISTS expediente_cifrado (
    id_expediente UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_autorizado UUID NOT NULL UNIQUE REFERENCES adulto_autorizado(id_autorizado) ON DELETE CASCADE,
    consentimiento_firmado_por_acudiente UUID NOT NULL REFERENCES acudiente(id_acudiente) ON DELETE RESTRICT,
    foto_rostro_cifrada formato_cifrado_aes NOT NULL, -- Imagen facial para cotejo visual de entrega
    foto_cedula_cifrada formato_cifrado_aes NOT NULL,
    consentimiento_ley1581_pdf_url TEXT NOT NULL,
    fecha_consentimiento TIMESTAMPTZ NOT NULL,
    verificado_por_coordinacion BOOLEAN NOT NULL DEFAULT FALSE,
    verificado_por_coordinador UUID REFERENCES coordinador(id_coordinador) ON DELETE RESTRICT,
    fecha_verificacion TIMESTAMPTZ,
    revocado BOOLEAN NOT NULL DEFAULT FALSE,
    hash_integridad_sha256 VARCHAR(64) NOT NULL,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- 18. ALERTAS JUDICIALES Y MEDIDAS CAUTELARES (RF-07, HU-07, RN-04, RNF-08)
CREATE TABLE IF NOT EXISTS alerta_judicial (
    id_alerta UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_estudiante UUID NOT NULL REFERENCES estudiante(id_estudiante) ON DELETE CASCADE,
    juzgado_emisor VARCHAR(150) NOT NULL,
    radicado_medida VARCHAR(50) NOT NULL UNIQUE,
    foto_individuo_cifrada formato_cifrado_aes NOT NULL,
    individuo_restringido_nombre_cifrado formato_cifrado_aes NOT NULL,
    individuo_restringido_documento_cifrado formato_cifrado_aes NOT NULL,
    individuo_blind_index VARCHAR(64) NOT NULL, -- HMAC-SHA256 para validación instantánea en parada
    orden_judicial_resumen_cifrado formato_cifrado_aes NOT NULL,
    activa BOOLEAN NOT NULL DEFAULT TRUE,
    fecha_registro TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    registrado_por_rectoria UUID NOT NULL REFERENCES usuario(id_usuario) ON DELETE RESTRICT,
    eliminado_soft BOOLEAN NOT NULL DEFAULT FALSE,
    eliminado_en TIMESTAMPTZ,
    eliminado_por_coordinacion UUID REFERENCES coordinador(id_coordinador) ON DELETE RESTRICT,
    autorizado_excepcion_por VARCHAR(100),
    hash_integridad_sha256 VARCHAR(64) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerta_blind_index ON alerta_judicial(individuo_blind_index);
CREATE INDEX IF NOT EXISTS idx_alerta_estudiante ON alerta_judicial(id_estudiante) WHERE activa = TRUE;

COMMIT;

