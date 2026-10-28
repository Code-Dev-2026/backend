-- ============================================================================
-- MIGRACIÓN V005: VIAJES, EXCLUSIONES BTREE_GIST, PASAJEROS OCASIONALES Y PARTICIONADO GPS
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS viaje (
    id_viaje UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_ruta UUID NOT NULL REFERENCES ruta(id_ruta) ON DELETE RESTRICT,
    id_vehiculo UUID NOT NULL REFERENCES vehiculo(id_vehiculo) ON DELETE RESTRICT,
    id_conductor UUID NOT NULL REFERENCES conductor(id_conductor) ON DELETE RESTRICT,
    id_monitora UUID NOT NULL REFERENCES monitora(id_monitora) ON DELETE RESTRICT,
    fecha DATE NOT NULL,
    hora_inicio_programada TIMESTAMPTZ NOT NULL,
    hora_fin_programada TIMESTAMPTZ NOT NULL,
    estado VARCHAR(20) NOT NULL DEFAULT 'PROGRAMADO' 
        CHECK (estado IN ('PROGRAMADO', 'EN_CURSO', 'FINALIZADO', 'CANCELADO')),
    hora_inicio_real TIMESTAMPTZ,
    hora_fin_real TIMESTAMPTZ,
    total_a_bordo INT NOT NULL DEFAULT 0 CHECK (total_a_bordo >= 0),
    CONSTRAINT chk_horas_programadas CHECK (hora_inicio_programada < hora_fin_programada),
    -- EXCLUSIONES ATÓMICAS MEDIANTE BTREE_GIST: Cero Doble Reserva (Usa exclusivamente horarios programados)
    CONSTRAINT excl_viaje_conductor_horario EXCLUDE USING gist (
        id_conductor WITH =,
        tstzrange(hora_inicio_programada, hora_fin_programada) WITH &&
    ) WHERE (estado IN ('PROGRAMADO', 'EN_CURSO')),
    CONSTRAINT excl_viaje_vehiculo_horario EXCLUDE USING gist (
        id_vehiculo WITH =,
        tstzrange(hora_inicio_programada, hora_fin_programada) WITH &&
    ) WHERE (estado IN ('PROGRAMADO', 'EN_CURSO')),
    CONSTRAINT excl_viaje_monitora_horario EXCLUDE USING gist (
        id_monitora WITH =,
        tstzrange(hora_inicio_programada, hora_fin_programada) WITH &&
    ) WHERE (estado IN ('PROGRAMADO', 'EN_CURSO'))
);
CREATE INDEX IF NOT EXISTS idx_viaje_operativo ON viaje(fecha, estado, id_vehiculo);

-- Estado de Custodia Aislado por Viaje (Soporta Mañana, Tarde y Días Consecutivos)
CREATE TABLE IF NOT EXISTS viaje_estudiante (
    id_viaje UUID NOT NULL REFERENCES viaje(id_viaje) ON DELETE RESTRICT,
    id_estudiante UUID NOT NULL REFERENCES estudiante(id_estudiante) ON DELETE RESTRICT,
    estado_custodia VARCHAR(30) NOT NULL DEFAULT 'EN_CASA_ESPERA'
        CHECK (estado_custodia IN (
            'EN_CASA_ESPERA', 
            'A_BORDO_VEHICULO', 
            'ENTREGADO_ADULTO_AUTORIZADO', 
            'RETORNO_SEGURO_SEDE', 
            'EN_CUSTODIA_INSTITUCIONAL', 
            'AUSENTE_CONFIRMADO'
        )),
    es_pasajero_ocasional BOOLEAN NOT NULL DEFAULT FALSE,
    hora_abordaje TIMESTAMPTZ,
    hora_desembarque TIMESTAMPTZ,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id_viaje, id_estudiante)
);
CREATE INDEX IF NOT EXISTS idx_viaje_estudiante_estado ON viaje_estudiante(id_viaje, estado_custodia);

-- Registro Formal de Inasistencias Previas (RF-04, RN-03)
CREATE TABLE IF NOT EXISTS inasistencia (
    id_inasistencia UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_estudiante UUID NOT NULL REFERENCES estudiante(id_estudiante) ON DELETE CASCADE,
    id_viaje UUID NOT NULL REFERENCES viaje(id_viaje) ON DELETE RESTRICT,
    reportado_por_acudiente UUID NOT NULL REFERENCES acudiente(id_acudiente) ON DELETE RESTRICT,
    motivo TEXT,
    fecha_reporte TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cupo_liberado BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_inasistencia_estudiante_viaje UNIQUE (id_estudiante, id_viaje)
);

CREATE TABLE IF NOT EXISTS pasajero_ocasional (
    id_pasajero_ocasional UUID PRIMARY KEY DEFAULT fn_uuid_generate_v7(),
    id_estudiante UUID NOT NULL REFERENCES estudiante(id_estudiante) ON DELETE CASCADE,
    id_viaje UUID NOT NULL REFERENCES viaje(id_viaje) ON DELETE RESTRICT,
    id_estudiante_que_libera_cupo UUID NOT NULL REFERENCES estudiante(id_estudiante) ON DELETE RESTRICT,
    qr_provisional_hash VARCHAR(64) NOT NULL UNIQUE,
    estado_solicitud VARCHAR(30) NOT NULL DEFAULT 'RADICADA' 
        CHECK (estado_solicitud IN ('RADICADA', 'APROBADO_COORDINACION', 'RECHAZADA', 'UTILIZADO')),
    solicitado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    aprobado_en TIMESTAMPTZ,
    aprobado_por_coordinador UUID REFERENCES coordinador(id_coordinador) ON DELETE RESTRICT
);

-- UNIQUE PARCIAL: Una inasistencia solo puede liberar exactamente UN cupo en el mismo viaje
CREATE UNIQUE INDEX IF NOT EXISTS uq_pasajero_ocasional_cupo_liberado 
    ON pasajero_ocasional (id_viaje, id_estudiante_que_libera_cupo) 
    WHERE (estado_solicitud IN ('RADICADA', 'APROBADO_COORDINACION', 'UTILIZADO'));

-- REGLAS SRS RN-03 Y HU-04: Antelación (>=2h contra hora programada) y Vacante por Inasistencia Previa
CREATE OR REPLACE FUNCTION fn_validar_reglas_pasajero_ocasional()
RETURNS TRIGGER AS $$
DECLARE
    v_hora_inicio_prog TIMESTAMPTZ;
    v_existe_inasistencia BOOLEAN;
BEGIN
    SELECT hora_inicio_programada INTO v_hora_inicio_prog
    FROM viaje WHERE id_viaje = NEW.id_viaje;

    -- 1. Regla de Antelación: Mínimo 2 horas antes de la hora programada de partida
    IF NEW.solicitado_en > (v_hora_inicio_prog - INTERVAL '2 hours') THEN
        RAISE EXCEPTION 'DENEGACIÓN POR RADICACIÓN TARDÍA (SRS HU-04): La solicitud debe radicarse con al menos 2 horas de anticipación.'
            USING ERRCODE = '23514';
    END IF;

    -- 2. Regla de Vacante Requerida: El menor liberador debe tener inasistencia formalmente registrada
    SELECT EXISTS (
        SELECT 1 FROM inasistencia 
        WHERE id_viaje = NEW.id_viaje 
          AND id_estudiante = NEW.id_estudiante_que_libera_cupo
          AND cupo_liberado = TRUE
    ) INTO v_existe_inasistencia;

    IF NOT v_existe_inasistencia THEN
        RAISE EXCEPTION 'DENEGACIÓN POR FALTA DE CUPO (SRS RN-03): Solo se habilitan invitaciones si existe cupo liberado por inasistencia previa reportada.'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validar_pasajero_ocasional ON pasajero_ocasional;
CREATE TRIGGER trg_validar_pasajero_ocasional
BEFORE INSERT ON pasajero_ocasional
FOR EACH ROW EXECUTE FUNCTION fn_validar_reglas_pasajero_ocasional();

-- PARTICIONAMIENTO: REGISTRO_GPS por Rango de Fecha Mensual (UTC)
CREATE TABLE IF NOT EXISTS registro_gps (
    id_gps UUID NOT NULL DEFAULT fn_uuid_generate_v7(),
    id_viaje UUID NOT NULL,
    id_vehiculo UUID NOT NULL,
    coordenada GEOGRAPHY(Point, 4326) NOT NULL,
    velocidad_kmh DECIMAL(5,2) NOT NULL,
    rumbo_grados DECIMAL(5,2) NOT NULL,
    precision_hdop DECIMAL(4,2) NOT NULL,
    bateria_respaldo_activa BOOLEAN NOT NULL DEFAULT FALSE,
    fecha_hora TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (fecha_hora, id_gps)
) PARTITION BY RANGE (fecha_hora);

-- Partición DEFAULT de resguardo para eventos atípicos
CREATE TABLE IF NOT EXISTS registro_gps_default PARTITION OF registro_gps DEFAULT;

CREATE INDEX IF NOT EXISTS idx_gps_coordenada ON registro_gps USING GIST (coordenada);
CREATE INDEX IF NOT EXISTS idx_gps_viaje_tiempo ON registro_gps(id_viaje, fecha_hora DESC);

-- Procedimientos de Creación y Purga (Con límites UTC y DETACH previo a DROP)
CREATE OR REPLACE PROCEDURE sp_crear_particiones_gps(p_meses_adelante INT DEFAULT 2)
AS $$
DECLARE
    v_inicio_mes TIMESTAMPTZ;
    v_fin_mes TIMESTAMPTZ;
    v_nom_part TEXT;
    i INT;
BEGIN
    FOR i IN 0..p_meses_adelante LOOP
        v_inicio_mes := (date_trunc('month', NOW() AT TIME ZONE 'UTC') + (i || ' month')::interval) AT TIME ZONE 'UTC';
        v_fin_mes := (v_inicio_mes + INTERVAL '1 month');
        v_nom_part := 'registro_gps_' || to_char(v_inicio_mes AT TIME ZONE 'UTC', 'YYYY_MM');

        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF registro_gps FOR VALUES FROM (%L) TO (%L);',
            v_nom_part, v_inicio_mes, v_fin_mes
        );
    END LOOP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE PROCEDURE sp_purgar_particiones_gps(p_dias_retencion INT DEFAULT 180)
AS $$
DECLARE
    v_fecha_limite TIMESTAMPTZ;
    r RECORD;
BEGIN
    v_fecha_limite := (NOW() AT TIME ZONE 'UTC') - (p_dias_retencion || ' days')::interval;

    FOR r IN (
        SELECT inhrelid::regclass::text AS tabla_particion
        FROM pg_inherits
        WHERE inhparent = 'registro_gps'::regclass
    ) LOOP
        IF r.tabla_particion ~ '^registro_gps_[0-9]{4}_[0-9]{2}$' THEN
            IF to_date(substring(r.tabla_particion from 14 for 7), 'YYYY_MM') < date_trunc('month', v_fecha_limite)::date THEN
                -- Desacoplamiento seguro antes del borrado físico (SRS RNF-08)
                EXECUTE format('ALTER TABLE registro_gps DETACH PARTITION %I CONCURRENTLY;', r.tabla_particion);
                EXECUTE format('DROP TABLE IF EXISTS %I CASCADE;', r.tabla_particion);
            END IF;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMIT;
