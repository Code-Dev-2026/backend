-- ============================================================================
-- CAMINO SEGURO - MOTOR CORE & CUSTODIA (COLEGIO SAN BENITO DEL OTÚN)
-- V007__notifications_and_offline_sync.sql
-- Sub-sistemas: Notificaciones Multi-canal, Tokens FCM, Comunicados,
--               Sincronización Offline Idempotente e Importación de Matrículas
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. CATÁLOGO DE TIPOS DE NOTIFICACIÓN
-- RF-12, RF-13, RF-14, RNF-05
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tipo_notificacion (
    id_tipo SERIAL PRIMARY KEY,
    codigo VARCHAR(50) NOT NULL UNIQUE,
    nombre VARCHAR(100) NOT NULL,
    descripcion TEXT,
    canal_default VARCHAR(20) NOT NULL DEFAULT 'PUSH'
        CHECK (canal_default IN ('PUSH', 'SMS', 'WHATSAPP', 'EMAIL', 'SISTEMA')),
    es_critica BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO tipo_notificacion (codigo, nombre, descripcion, canal_default, es_critica) VALUES
('ABORDAJE_EXITOSO', 'Abordaje Confirmado', 'El estudiante ha subido al vehículo escolar', 'PUSH', false),
('DESCENSO_EXITOSO', 'Descenso Confirmado', 'El estudiante ha sido entregado en la parada correspondiente', 'PUSH', false),
('PROXIMIDAD_PARADA', 'Aviso de Proximidad', 'El vehículo escolar está a menos de 500 metros de su parada', 'PUSH', false),
('DESVIO_RUTA_SIGNIFICATIVO', 'Alerta Desvío de Ruta', 'El vehículo se ha desviado más de 300 metros del trayecto autorizado', 'PUSH', true),
('DETENCION_PROLONGADA', 'Alerta Detención Prolongada', 'El vehículo se encuentra inmóvil fuera de parada por más de 5 minutos', 'PUSH', true),
('EXCESO_VELOCIDAD', 'Alerta Exceso de Velocidad', 'El vehículo excedió el límite de velocidad escolar configurado', 'PUSH', true),
('INCIDENTE_ENTREGA', 'Incidente en Desembarque', 'Imposibilidad de entregar al menor o intento con persona no autorizada', 'SMS', true),
('ALERTA_JUDICIAL_ACTIVADA', 'Alerta de Protección Judicial', 'Detección de individuo con restricción judicial en punto de entrega', 'SMS', true),
('COMUNICADO_INSTITUCIONAL', 'Comunicado General', 'Avisos operativos, contingencias climáticas o cambios de ruta', 'PUSH', false)
ON CONFLICT (codigo) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. DISPOSITIVOS MÓVILES REGISTRADOS (FCM / APNS)
-- RF-12, RNF-05
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dispositivo_usuario (
    id_dispositivo UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    id_usuario UUID NOT NULL REFERENCES usuario(id_usuario) ON DELETE CASCADE,
    fcm_token TEXT NOT NULL,
    plataforma VARCHAR(20) NOT NULL CHECK (plataforma IN ('ANDROID', 'IOS', 'WEB')),
    modelo VARCHAR(100),
    sistema_operativo VARCHAR(50),
    version_app VARCHAR(50),
    activo BOOLEAN NOT NULL DEFAULT true,
    fecha_ultimo_acceso TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT unq_usuario_fcm_token UNIQUE (id_usuario, fcm_token)
);

CREATE INDEX IF NOT EXISTS idx_dispositivo_usuario ON dispositivo_usuario(id_usuario) WHERE activo = true;

-- ----------------------------------------------------------------------------
-- 3. NOTIFICACIONES TRANSACCIONALES
-- RF-12, RF-13, RF-14, RNF-05
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notificacion (
    id_notificacion UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    id_estudiante UUID REFERENCES estudiante(id_estudiante) ON DELETE SET NULL,
    id_acudiente UUID NOT NULL REFERENCES acudiente(id_acudiente) ON DELETE CASCADE,
    id_viaje UUID REFERENCES viaje(id_viaje) ON DELETE SET NULL,
    id_tipo INT NOT NULL REFERENCES tipo_notificacion(id_tipo) ON DELETE RESTRICT,
    canal VARCHAR(20) NOT NULL CHECK (canal IN ('PUSH', 'SMS', 'WHATSAPP', 'EMAIL', 'SISTEMA')),
    titulo VARCHAR(150) NOT NULL,
    mensaje TEXT NOT NULL,
    payload_adicional JSONB DEFAULT '{}'::jsonb,
    estado VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE'
        CHECK (estado IN ('PENDIENTE', 'ENVIADA', 'ENTREGADA', 'LEIDA', 'FALLIDA', 'REINTENTO')),
    intentos_envio INT NOT NULL DEFAULT 0,
    max_intentos INT NOT NULL DEFAULT 3,
    ultimo_error TEXT,
    fecha_envio_programada TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    fecha_enviada TIMESTAMPTZ,
    fecha_leida TIMESTAMPTZ,
    idempotency_key VARCHAR(120) UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_notif_estudiante_acudiente FOREIGN KEY (id_estudiante, id_acudiente)
        REFERENCES estudiante_acudiente(id_estudiante, id_acudiente) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notif_acudiente_fecha ON notificacion(id_acudiente, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_cola_pendientes ON notificacion(fecha_envio_programada)
    WHERE estado IN ('PENDIENTE', 'REINTENTO');
CREATE INDEX IF NOT EXISTS idx_notif_viaje ON notificacion(id_viaje) WHERE id_viaje IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 4. COMUNICADOS GENERALES, ZONALES Y OPERATIVOS
-- RF-14
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comunicado (
    id_comunicado UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    id_emisor UUID NOT NULL REFERENCES usuario(id_usuario) ON DELETE RESTRICT,
    alcance VARCHAR(20) NOT NULL CHECK (alcance IN ('GENERAL_COLEGIO', 'RUTA', 'ZONA', 'INDIVIDUAL')),
    nivel_urgencia VARCHAR(20) NOT NULL DEFAULT 'INFORMATIVO'
        CHECK (nivel_urgencia IN ('INFORMATIVO', 'ALERTA', 'URGENTE')),
    silenciable BOOLEAN NOT NULL DEFAULT false,
    titulo VARCHAR(200) NOT NULL,
    contenido TEXT NOT NULL,
    id_ruta UUID REFERENCES ruta(id_ruta) ON DELETE CASCADE,
    id_zona UUID REFERENCES zona_geografica(id_zona) ON DELETE SET NULL,
    fecha_publicacion TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    fecha_expiracion TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_alcance_coherencia CHECK (
        (alcance = 'GENERAL_COLEGIO' AND id_ruta IS NULL AND id_zona IS NULL) OR
        (alcance = 'RUTA' AND id_ruta IS NOT NULL) OR
        (alcance = 'ZONA' AND id_zona IS NOT NULL) OR
        (alcance = 'INDIVIDUAL')
    )
);

CREATE INDEX IF NOT EXISTS idx_comunicado_vigente ON comunicado(fecha_publicacion, fecha_expiracion);

-- ----------------------------------------------------------------------------
-- 5. SINCRONIZACIÓN OFFLINE IDEMPOTENTE (APP MONITORA)
-- RF-06, RF-08, RNF-04, RNF-08
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_operation (
    id_sync UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    id_dispositivo VARCHAR(120) NOT NULL,
    idempotency_key VARCHAR(120) NOT NULL,
    entidad_objetivo VARCHAR(60) NOT NULL,
    operacion VARCHAR(20) NOT NULL CHECK (operacion IN ('INSERT', 'UPDATE', 'DELETE', 'BATCH_ASISTENCIA')),
    payload JSONB NOT NULL,
    estado_sync VARCHAR(20) NOT NULL DEFAULT 'PROCESADO'
        CHECK (estado_sync IN ('PENDIENTE', 'PROCESADO', 'CONFLICTO', 'DESCARTADO')),
    fecha_cliente TIMESTAMPTZ NOT NULL,
    fecha_servidor TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    resultado_json JSONB,
    CONSTRAINT unq_sync_dispositivo_idempotency UNIQUE (id_dispositivo, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_sync_fecha_servidor ON sync_operation(fecha_servidor DESC);

-- ----------------------------------------------------------------------------
-- 6. IMPORTACIÓN MASIVA DE MATRÍCULAS (CSV / EXCEL)
-- RF-01, RF-02, RF-04
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS importacion_matricula (
    id_importacion UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
    id_usuario_responsable UUID NOT NULL REFERENCES usuario(id_usuario) ON DELETE RESTRICT,
    nombre_archivo VARCHAR(255) NOT NULL,
    hash_sha256_archivo VARCHAR(64) NOT NULL,
    total_registros INT NOT NULL CHECK (total_registros >= 0),
    registros_procesados INT NOT NULL DEFAULT 0,
    registros_exitosos INT NOT NULL DEFAULT 0,
    registros_rechazados INT NOT NULL DEFAULT 0,
    errores JSONB DEFAULT '[]'::jsonb,
    estado VARCHAR(20) NOT NULL DEFAULT 'EN_PROCESO'
        CHECK (estado IN ('SUBIDO', 'VALIDANDO', 'EN_PROCESO', 'COMPLETADO', 'FALLIDO_PARCIAL', 'FALLIDO_TOTAL')),
    fecha_inicio TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    fecha_fin TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
