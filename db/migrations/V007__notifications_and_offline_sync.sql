-- ============================================================================
-- CAMINO SEGURO - BACKEND CORE DDL (POSTGRESQL 16 + POSTGIS 3.4)
-- Archivo: V007__notifications_and_offline_sync.sql
-- Subdominio: Notificaciones Transaccionales, Comunicados, Sincronización Offline e Importación
-- Requisitos SRS: RF-01, RF-06, RF-08, RF-10, RF-12, RF-13, RF-14, RF-20, RNF-04, RNF-05, RNF-06, RNF-08
-- Tablas creadas: 5
-- ============================================================================

BEGIN;

-- 35. CATÁLOGO DE TIPOS DE NOTIFICACIÓN (RF-12, RF-13, RF-14, RNF-05)
CREATE TABLE IF NOT EXISTS tipo_notificacion (
    id_tipo UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    codigo VARCHAR(50) NOT NULL UNIQUE,
    nombre VARCHAR(100) NOT NULL,
    plantilla_mensaje TEXT NOT NULL,
    nivel_severidad VARCHAR(20) NOT NULL DEFAULT 'INFORMATIVO'
        CHECK (nivel_severidad IN ('INFORMATIVO', 'ADVERTENCIA', 'CRITICO')),
    canal_default VARCHAR(20) NOT NULL DEFAULT 'PUSH'
        CHECK (canal_default IN ('PUSH', 'SMS', 'WHATSAPP', 'EMAIL', 'SISTEMA')),
    es_critica BOOLEAN NOT NULL DEFAULT FALSE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Inserción de Catálogo Oficial Semilla
INSERT INTO tipo_notificacion (codigo, nombre, plantilla_mensaje, nivel_severidad, canal_default, es_critica) VALUES
('ABORDAJE_EXITOSO', 'Abordaje Confirmado', 'El estudiante ha subido al vehiculo escolar.', 'INFORMATIVO', 'PUSH', FALSE),
('DESCENSO_EXITOSO', 'Descenso Confirmado', 'El estudiante ha sido entregado exitosamente en la parada autorizada.', 'INFORMATIVO', 'PUSH', FALSE),
('PROXIMIDAD_PARADA', 'Aviso de Proximidad', 'El vehiculo escolar se encuentra a menos de 500 metros de su parada.', 'INFORMATIVO', 'PUSH', FALSE),
('DESVIO_RUTA_SIGNIFICATIVO', 'Alerta Desvio de Ruta', 'El vehiculo se ha desviado mas de 300 metros del trayecto vial oficial.', 'CRITICO', 'PUSH', TRUE),
('DETENCION_PROLONGADA', 'Alerta Detencion Prolongada', 'El vehiculo se encuentra inmovil fuera de parada por mas de 5 minutos.', 'CRITICO', 'PUSH', TRUE),
('EXCESO_VELOCIDAD', 'Alerta Exceso de Velocidad', 'El vehiculo excedio el limite de velocidad escolar configurado.', 'CRITICO', 'PUSH', TRUE),
('INCIDENTE_ENTREGA', 'Incidente en Desembarque', 'Imposibilidad de entregar al menor o intento con persona no autorizada.', 'CRITICO', 'SMS', TRUE),
('ALERTA_JUDICIAL_ACTIVADA', 'Alerta de Proteccion Judicial', 'Deteccion de individuo con restriccion judicial en punto de parada.', 'CRITICO', 'SMS', TRUE),
('COMUNICADO_INSTITUCIONAL', 'Comunicado General', 'Avisos operativos, contingencias climaticas o cambios de programacion.', 'INFORMATIVO', 'PUSH', FALSE)
ON CONFLICT (codigo) DO NOTHING;

-- 36. NOTIFICACIONES TRANSACCIONALES MULTI-CANAL
CREATE TABLE IF NOT EXISTS notificacion (
    id_notificacion UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_tipo UUID NOT NULL REFERENCES tipo_notificacion(id_tipo) ON DELETE RESTRICT,
    id_estudiante UUID REFERENCES estudiante(id_estudiante) ON DELETE SET NULL,
    id_acudiente UUID NOT NULL REFERENCES acudiente(id_acudiente) ON DELETE CASCADE,
    id_viaje UUID REFERENCES viaje(id_viaje) ON DELETE SET NULL,
    canal VARCHAR(20) NOT NULL CHECK (canal IN ('PUSH', 'SMS', 'WHATSAPP', 'EMAIL', 'SISTEMA')),
    titulo VARCHAR(150) NOT NULL,
    contenido_mensaje TEXT NOT NULL,
    payload_adicional JSONB DEFAULT '{}'::jsonb,
    silenciable BOOLEAN NOT NULL DEFAULT FALSE,
    estado_envio VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE'
        CHECK (estado_envio IN ('PENDIENTE', 'ENVIADA', 'ENTREGADA', 'LEIDA', 'FALLIDA', 'REINTENTO')),
    intentos_realizados INT NOT NULL DEFAULT 0,
    max_intentos INT NOT NULL DEFAULT 3,
    ultimo_error TEXT,
    idempotency_key VARCHAR(120) UNIQUE,
    despachada_en TIMESTAMPTZ,
    entregada_en TIMESTAMPTZ,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_notif_estudiante_acudiente FOREIGN KEY (id_estudiante, id_acudiente)
        REFERENCES estudiante_acudiente(id_estudiante, id_acudiente) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_notif_acudiente_fecha ON notificacion(id_acudiente, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_notif_cola_pendientes ON notificacion(creado_en)
    WHERE estado_envio IN ('PENDIENTE', 'REINTENTO');
CREATE INDEX IF NOT EXISTS idx_notif_viaje ON notificacion(id_viaje) WHERE id_viaje IS NOT NULL;

-- 37. COMUNICADOS GENERALES Y BOLETINES OPERATIVOS (RF-14)
CREATE TABLE IF NOT EXISTS comunicado (
    id_comunicado UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    emitido_por_coordinador UUID NOT NULL REFERENCES usuario(id_usuario) ON DELETE RESTRICT,
    alcance VARCHAR(20) NOT NULL CHECK (alcance IN ('GENERAL_COLEGIO', 'RUTA', 'ZONA', 'INDIVIDUAL')),
    severidad VARCHAR(20) NOT NULL DEFAULT 'INFORMATIVO'
        CHECK (severidad IN ('INFORMATIVO', 'ALERTA', 'URGENTE')),
    silenciable BOOLEAN NOT NULL DEFAULT FALSE,
    titulo VARCHAR(200) NOT NULL,
    mensaje TEXT NOT NULL,
    id_ruta_objetivo UUID REFERENCES ruta(id_ruta) ON DELETE CASCADE,
    id_zona_objetivo UUID REFERENCES zona_geografica(id_zona) ON DELETE SET NULL,
    fecha_emision TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    fecha_expiracion TIMESTAMPTZ,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_alcance_coherencia CHECK (
        (alcance = 'GENERAL_COLEGIO' AND id_ruta_objetivo IS NULL AND id_zona_objetivo IS NULL) OR
        (alcance = 'RUTA' AND id_ruta_objetivo IS NOT NULL) OR
        (alcance = 'ZONA' AND id_zona_objetivo IS NOT NULL) OR
        (alcance = 'INDIVIDUAL')
    )
);
CREATE INDEX IF NOT EXISTS idx_comunicado_vigente ON comunicado(fecha_emision, fecha_expiracion);

-- 38. COLA DE RECONCILIACIÓN OFFLINE IDEMPOTENTE (RF-10, RNF-06)
CREATE TABLE IF NOT EXISTS sync_operation (
    id_sync UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_dispositivo UUID NOT NULL REFERENCES dispositivo(id_dispositivo) ON DELETE CASCADE,
    idempotency_key VARCHAR(120) NOT NULL,
    entidad_afectada VARCHAR(60) NOT NULL,
    operacion_tipo VARCHAR(20) NOT NULL CHECK (operacion_tipo IN ('INSERT', 'UPDATE', 'DELETE', 'BATCH_ASISTENCIA')),
    payload_json JSONB NOT NULL,
    estado_sync VARCHAR(20) NOT NULL DEFAULT 'PROCESADO'
        CHECK (estado_sync IN ('PENDIENTE', 'PROCESADO', 'CONFLICTO', 'DESCARTADO')),
    capturada_en_offline TIMESTAMPTZ NOT NULL,
    procesada_en_servidor TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    resultado_json JSONB,
    CONSTRAINT unq_sync_dispositivo_idempotency UNIQUE (id_dispositivo, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_sync_fecha_servidor ON sync_operation(procesada_en_servidor DESC);

-- 39. IMPORTACIÓN MASIVA Y AUDITORÍA DE MATRÍCULAS (RF-01, HU-01)
CREATE TABLE IF NOT EXISTS importacion_matricula (
    id_importacion UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_colegio UUID NOT NULL REFERENCES colegio(id_colegio) ON DELETE RESTRICT,
    cargado_por_usuario UUID NOT NULL REFERENCES usuario(id_usuario) ON DELETE RESTRICT,
    nombre_archivo VARCHAR(255) NOT NULL,
    hash_sha256_archivo VARCHAR(64) NOT NULL,
    total_registros INT NOT NULL CHECK (total_registros >= 0),
    procesados_exitosos INT NOT NULL DEFAULT 0,
    registros_con_error INT NOT NULL DEFAULT 0,
    inconsistencias_detalle JSONB DEFAULT '[]'::jsonb,
    estado VARCHAR(20) NOT NULL DEFAULT 'EN_PROCESO'
        CHECK (estado IN ('SUBIDO', 'VALIDANDO', 'EN_PROCESO', 'COMPLETADO', 'FALLIDO_PARCIAL', 'FALLIDO_TOTAL')),
    fecha_carga TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    fecha_fin TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_importacion_colegio ON importacion_matricula(id_colegio);

COMMIT;

