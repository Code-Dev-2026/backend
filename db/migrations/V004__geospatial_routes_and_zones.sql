-- ============================================================================
-- MIGRACIÓN V004: INFRAESTRUCTURA GEOESPACIAL (POSTGIS NATIVO), RUTAS Y PARADAS
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS vehiculo (
    id_vehiculo UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_empresa UUID NOT NULL REFERENCES empresa_transportadora(id_empresa) ON DELETE RESTRICT,
    placa VARCHAR(10) NOT NULL UNIQUE,
    capacidad_nominal INT NOT NULL CHECK (capacidad_nominal > 0),
    numero_movil VARCHAR(20) NOT NULL,
    modelo VARCHAR(50) NOT NULL,
    tarjeta_operacion VARCHAR(50) NOT NULL UNIQUE,
    imei_gps_fijo VARCHAR(30) NOT NULL UNIQUE,
    activo BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS ruta (
    id_ruta UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_colegio UUID NOT NULL REFERENCES colegio(id_colegio) ON DELETE RESTRICT,
    id_empresa UUID NOT NULL REFERENCES empresa_transportadora(id_empresa) ON DELETE RESTRICT,
    codigo VARCHAR(20) NOT NULL UNIQUE,
    nombre VARCHAR(100) NOT NULL,
    jornada VARCHAR(20) NOT NULL CHECK (jornada IN ('MANANA', 'TARDE', 'COMPLETA')),
    polilinea_oficial GEOGRAPHY(LineString, 4326) NOT NULL,
    origen_nombre VARCHAR(100) NOT NULL,
    destino_nombre VARCHAR(100) NOT NULL,
    activa BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_ruta_polilinea ON ruta USING GIST (polilinea_oficial);

CREATE TABLE IF NOT EXISTS parada (
    id_parada UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_ruta UUID NOT NULL REFERENCES ruta(id_ruta) ON DELETE CASCADE,
    nombre VARCHAR(100) NOT NULL,
    orden_secuencia INT NOT NULL,
    punto_geografico GEOGRAPHY(Point, 4326) NOT NULL,
    horario_estimado TIME NOT NULL,
    radio_geocerca GEOGRAPHY(Polygon, 4326) NOT NULL,
    CONSTRAINT uq_parada_ruta_secuencia UNIQUE (id_ruta, orden_secuencia),
    CONSTRAINT uq_parada_ruta_parada UNIQUE (id_ruta, id_parada)
);
CREATE INDEX IF NOT EXISTS idx_parada_punto ON parada USING GIST (punto_geografico);
CREATE INDEX IF NOT EXISTS idx_parada_geocerca ON parada USING GIST (radio_geocerca);

CREATE TABLE IF NOT EXISTS asignacion_ruta (
    id_asignacion UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_estudiante UUID NOT NULL REFERENCES estudiante(id_estudiante) ON DELETE CASCADE,
    id_ruta UUID NOT NULL REFERENCES ruta(id_ruta) ON DELETE RESTRICT,
    id_parada_subida UUID NOT NULL,
    id_parada_bajada UUID NOT NULL,
    ciclo_horario VARCHAR(20) NOT NULL CHECK (ciclo_horario IN ('IDA', 'RETORNO', 'AMBOS')),
    activa BOOLEAN NOT NULL DEFAULT TRUE,
    fecha_asignacion TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- FKs compuestos: Garantizan que las paradas pertenecen matemáticamente a la ruta asignada
    CONSTRAINT fk_asignacion_subida_compuesta 
        FOREIGN KEY (id_ruta, id_parada_subida) REFERENCES parada(id_ruta, id_parada) ON DELETE RESTRICT,
    CONSTRAINT fk_asignacion_bajada_compuesta 
        FOREIGN KEY (id_ruta, id_parada_bajada) REFERENCES parada(id_ruta, id_parada) ON DELETE RESTRICT
);

-- Prevenir doble cupo simultáneo del mismo estudiante en la misma franja (HU-01)
CREATE UNIQUE INDEX IF NOT EXISTS uq_estudiante_asignacion_franja 
    ON asignacion_ruta (id_estudiante, ciclo_horario) 
    WHERE (activa = TRUE);

CREATE TABLE IF NOT EXISTS zona_geografica (
    id_zona UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    nombre VARCHAR(100) NOT NULL,
    tipo_zona VARCHAR(30) NOT NULL CHECK (tipo_zona IN ('SOMBRA_CELULAR', 'GEOCERCA_ESCOLAR', 'PERIMETRO_MUNICIPAL')),
    poligono GEOGRAPHY(Polygon, 4326) NOT NULL,
    descripcion TEXT,
    activa BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_zona_poligono ON zona_geografica USING GIST (poligono);

COMMIT;
