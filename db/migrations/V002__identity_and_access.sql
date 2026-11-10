-- ============================================================================
-- CAMINO SEGURO - BACKEND CORE DDL (POSTGRESQL 16 + POSTGIS 3.4)
-- Archivo: V002__identity_and_access.sql
-- Subdominio: Identidad, Control de Acceso (RBAC en Capas), Sesiones y Perfiles Operativos
-- Requisitos SRS: RF-01, RF-05, RF-09, RF-11, RF-13, RF-17, RF-19, RF-20, RNF-01, RNF-02, RNF-07
-- Tablas creadas: 13
-- ============================================================================

BEGIN;

-- 1. INSTITUCIÓN EDUCATIVA CONTRATANTE (Colegio San Benito del Otún)
CREATE TABLE IF NOT EXISTS colegio (
    id_colegio UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    nombre VARCHAR(150) NOT NULL,
    nit VARCHAR(20) NOT NULL UNIQUE,
    direccion VARCHAR(200) NOT NULL,
    telefono VARCHAR(30) NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- 2. OPERADOR LOGÍSTICO Y TRANSPORTADOR (Transportes Camino Seguro S.A.S.)
CREATE TABLE IF NOT EXISTS empresa_transportadora (
    id_empresa UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    razon_social VARCHAR(150) NOT NULL,
    nit VARCHAR(20) NOT NULL UNIQUE,
    telefono VARCHAR(30) NOT NULL,
    email_contacto VARCHAR(120) NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- 3. NÚCLEO DE AUTENTICACIÓN E IDENTIDAD CENTRALIZADA
CREATE TABLE IF NOT EXISTS usuario (
    id_usuario UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    email VARCHAR(120) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL, -- Hash Argon2id
    estado VARCHAR(20) NOT NULL DEFAULT 'ACTIVO' CHECK (estado IN ('ACTIVO', 'INACTIVO', 'BLOQUEADO')),
    mfa_habilitado BOOLEAN NOT NULL DEFAULT FALSE,
    ultimo_ingreso TIMESTAMPTZ,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- 4. MATRIZ OFICIAL DE ROLES RBAC (SRS RF-13)
CREATE TABLE IF NOT EXISTS rol (
    id_rol UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    nombre VARCHAR(50) NOT NULL UNIQUE,
    descripcion VARCHAR(255)
);

-- Inserción de los 8 roles oficiales del sistema
INSERT INTO rol (nombre, descripcion) VALUES
    ('COORDINADORA_CONVIVENCIA', 'Superadministrador institucional con MFA obligatorio y facultades de intervención'),
    ('RECTORIA', 'Máxima autoridad académica; registro y aval de alertas judiciales y convenios'),
    ('GERENCIA_TRANSPORTE', 'Dirección general de la empresa transportadora; fiscalización de flota'),
    ('JEFE_OPERACIONES', 'Planificación y despacho de rutas viales y programación vehicular'),
    ('ADMINISTRADOR_CARTERA', 'Gestión financiera y cobranza; estrictamente desacoplado de la operación'),
    ('MONITORA', 'Supervisión en ruta, escaneo QR de abordaje y verificación visual de entrega'),
    ('CONDUCTOR', 'Operador de automotor escolar; sin intrusión en terminal particular'),
    ('ACUDIENTE', 'Tutor legal del menor; consulta de mapa en vivo, autorizaciones y avisos')
ON CONFLICT (nombre) DO NOTHING;

-- 5. ASIGNACIÓN N:M USUARIO - ROLES
CREATE TABLE IF NOT EXISTS usuario_rol (
    id_usuario UUID NOT NULL REFERENCES usuario(id_usuario) ON DELETE CASCADE,
    id_rol UUID NOT NULL REFERENCES rol(id_rol) ON DELETE RESTRICT,
    asignado_en TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (id_usuario, id_rol)
);

-- 6. GESTIÓN DE SESIONES CON FAMILY_ID Y ROTACIÓN ANTIRROBO (ASVS V3.3)
CREATE TABLE IF NOT EXISTS refresh_token (
    id_token UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_usuario UUID NOT NULL REFERENCES usuario(id_usuario) ON DELETE CASCADE,
    family_id UUID NOT NULL, -- Agrupador de cadena para detección de reutilización / robo
    token_hash VARCHAR(64) NOT NULL UNIQUE, -- SHA-256 del refresh token
    revocado BOOLEAN NOT NULL DEFAULT FALSE,
    expira_en TIMESTAMPTZ NOT NULL,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_refresh_token_family ON refresh_token(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_token_usuario ON refresh_token(id_usuario);

-- 7. BÓVEDA DE SECRETOS TOTP / MFA PARA DIRECTIVAS (RF-13, RNF-01)
CREATE TABLE IF NOT EXISTS mfa_secret (
    id_mfa UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_usuario UUID NOT NULL UNIQUE REFERENCES usuario(id_usuario) ON DELETE CASCADE,
    secret_cifrado formato_cifrado_aes NOT NULL, -- Clave TOTP cifrada con AES-256-GCM
    backup_codes_hashes JSONB NOT NULL, -- Lista de hashes de códigos de recuperación
    confirmado BOOLEAN NOT NULL DEFAULT FALSE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- 8. DISPOSITIVOS MÓVILES REGISTRADOS Y TOKENS PUSH FCM (RF-12, RNF-05)
CREATE TABLE IF NOT EXISTS dispositivo (
    id_dispositivo UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_usuario UUID NOT NULL REFERENCES usuario(id_usuario) ON DELETE CASCADE,
    token_fcm VARCHAR(255) NOT NULL UNIQUE,
    sistema_operativo VARCHAR(20) NOT NULL CHECK (sistema_operativo IN ('ANDROID', 'IOS', 'WEB')),
    modelo_hardware VARCHAR(100),
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_dispositivo_usuario ON dispositivo(id_usuario);

-- 9. PERFIL DIRECTIVO: COORDINACIÓN DE CONVIVENCIA
CREATE TABLE IF NOT EXISTS coordinador (
    id_coordinador UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_usuario UUID NOT NULL UNIQUE REFERENCES usuario(id_usuario) ON DELETE CASCADE,
    id_colegio UUID NOT NULL REFERENCES colegio(id_colegio) ON DELETE RESTRICT,
    nombres VARCHAR(100) NOT NULL,
    apellidos VARCHAR(100) NOT NULL,
    cargo VARCHAR(100) NOT NULL,
    telefono VARCHAR(30) NOT NULL
);

-- 10. PERFIL CONDUCTOR (id_usuario opcional para salvaguardar no intrusión laboral: RNF-07, HU-09)
CREATE TABLE IF NOT EXISTS conductor (
    id_conductor UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_usuario UUID UNIQUE REFERENCES usuario(id_usuario) ON DELETE SET NULL,
    id_empresa UUID NOT NULL REFERENCES empresa_transportadora(id_empresa) ON DELETE RESTRICT,
    nombres VARCHAR(100) NOT NULL,
    apellidos VARCHAR(100) NOT NULL,
    numero_licencia VARCHAR(30) NOT NULL UNIQUE,
    vigencia_licencia DATE NOT NULL,
    telefono VARCHAR(30) NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_conductor_empresa ON conductor(id_empresa);

-- 11. PERFIL MONITORA DE RUTA (Validación y cotejo de custodia)
CREATE TABLE IF NOT EXISTS monitora (
    id_monitora UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_usuario UUID NOT NULL UNIQUE REFERENCES usuario(id_usuario) ON DELETE CASCADE,
    id_empresa UUID NOT NULL REFERENCES empresa_transportadora(id_empresa) ON DELETE RESTRICT,
    nombres VARCHAR(100) NOT NULL,
    apellidos VARCHAR(100) NOT NULL,
    documento_cifrado formato_cifrado_aes NOT NULL,
    documento_blind_index VARCHAR(64) NOT NULL UNIQUE,
    telefono VARCHAR(30) NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_monitora_blind_index ON monitora(documento_blind_index);

-- 12. PERFIL ACUDIENTE / TUTOR LEGAL DEL MENOR (Titular de patria potestad)
CREATE TABLE IF NOT EXISTS acudiente (
    id_acudiente UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_usuario UUID NOT NULL UNIQUE REFERENCES usuario(id_usuario) ON DELETE CASCADE,
    nombres VARCHAR(100) NOT NULL,
    apellidos VARCHAR(100) NOT NULL,
    documento_cifrado formato_cifrado_aes NOT NULL,
    documento_blind_index VARCHAR(64) NOT NULL UNIQUE,
    telefono_principal_cifrado formato_cifrado_aes NOT NULL,
    telefono_emergencia_cifrado formato_cifrado_aes NOT NULL,
    direccion_cifrada formato_cifrado_aes NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acudiente_blind_index ON acudiente(documento_blind_index);

-- 13. ADULTO AUTORIZADO (Terceros legitimados para retiro en parada, máx 3 por menor)
CREATE TABLE IF NOT EXISTS adulto_autorizado (
    id_autorizado UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    nombres VARCHAR(100) NOT NULL,
    apellidos VARCHAR(100) NOT NULL,
    documento_cifrado formato_cifrado_aes NOT NULL,
    documento_blind_index VARCHAR(64) NOT NULL UNIQUE,
    telefono_cifrado formato_cifrado_aes NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_adulto_autorizado_blind ON adulto_autorizado(documento_blind_index);

COMMIT;

