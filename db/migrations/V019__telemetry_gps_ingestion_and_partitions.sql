-- ============================================================================
-- CAMINO SEGURO - BACKEND CORE DDL (POSTGRESQL 16 + POSTGIS 3.4)
-- Archivo: V019__telemetry_gps_ingestion_and_partitions.sql
-- Issue #12: Ingesta de telemetría IoT vehicular vía broker MQTT y almacenamiento particionado
-- Requisitos SRS: RF-10, RNF-05, OWASP ASVS V1.14 / V10.3
-- Reversible mediante: db/migrations/undo/U019__telemetry_gps_ingestion_and_partitions.sql
-- ============================================================================

BEGIN;

-- 1. Ampliación retrocompatible de public.registro_gps (creada en V005)
--    Se añaden precisión en metros (para auditoría y descarte > 30 m) y odómetro vehicular.
ALTER TABLE public.registro_gps
    ADD COLUMN IF NOT EXISTS precision_metros NUMERIC(6,2),
    ADD COLUMN IF NOT EXISTS odometro_km NUMERIC(10,2);

-- 2. Invariantes de dominio a nivel de base de datos
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.registro_gps'::regclass
          AND conname = 'chk_registro_gps_precision_metros'
    ) THEN
        ALTER TABLE public.registro_gps
            ADD CONSTRAINT chk_registro_gps_precision_metros
            CHECK (precision_metros IS NULL OR (precision_metros >= 0 AND precision_metros <= 30));
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.registro_gps'::regclass
          AND conname = 'chk_registro_gps_odometro_km'
    ) THEN
        ALTER TABLE public.registro_gps
            ADD CONSTRAINT chk_registro_gps_odometro_km
            CHECK (odometro_km IS NULL OR odometro_km >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.registro_gps'::regclass
          AND conname = 'chk_registro_gps_velocidad_kmh'
    ) THEN
        ALTER TABLE public.registro_gps
            ADD CONSTRAINT chk_registro_gps_velocidad_kmh
            CHECK (velocidad_kmh >= 0 AND velocidad_kmh <= 250);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.registro_gps'::regclass
          AND conname = 'chk_registro_gps_rumbo_grados'
    ) THEN
        ALTER TABLE public.registro_gps
            ADD CONSTRAINT chk_registro_gps_rumbo_grados
            CHECK (rumbo_grados >= 0 AND rumbo_grados < 360);
    END IF;
END $$;

-- 3. Deduplicación idempotente e índice de consulta por vehículo y tiempo
--    Incluye la columna de partición (fecha_hora) como exige PostgreSQL 16.
CREATE UNIQUE INDEX IF NOT EXISTS uq_registro_gps_vehiculo_fecha
    ON public.registro_gps (id_vehiculo, fecha_hora);

CREATE INDEX IF NOT EXISTS idx_gps_vehiculo_tiempo
    ON public.registro_gps (id_vehiculo, fecha_hora DESC);

-- 4. Función SECURITY DEFINER de creación de particiones mensuales (Issue #12)
--    Reutiliza la convención registro_gps_YYYY_MM de V005, otorga SELECT/INSERT
--    a los roles operativos sin conceder permisos DDL generales (OWASP ASVS V1.14).
CREATE OR REPLACE FUNCTION public.fn_crear_particion_gps_mensual(
    p_fecha_referencia TIMESTAMPTZ DEFAULT NOW(),
    p_meses_adelante INT DEFAULT 2
)
RETURNS TABLE (
    nombre_particion TEXT,
    inicio_rango TIMESTAMPTZ,
    fin_rango TIMESTAMPTZ,
    creada BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_base_utc TIMESTAMP WITHOUT TIME ZONE;
    v_inicio_mes TIMESTAMPTZ;
    v_fin_mes TIMESTAMPTZ;
    v_nom_part TEXT;
    v_creada BOOLEAN;
    i INT;
BEGIN
    IF p_meses_adelante IS NULL OR p_meses_adelante < 0 OR p_meses_adelante > 24 THEN
        RAISE EXCEPTION 'PARAMETRO_INVALIDO: p_meses_adelante debe estar entre 0 y 24.'
            USING ERRCODE = '22023';
    END IF;

    v_base_utc := date_trunc('month', COALESCE(p_fecha_referencia, NOW()) AT TIME ZONE 'UTC');

    FOR i IN 0..p_meses_adelante LOOP
        v_inicio_mes := (v_base_utc + (i || ' month')::interval) AT TIME ZONE 'UTC';
        v_fin_mes := (v_base_utc + ((i + 1) || ' month')::interval) AT TIME ZONE 'UTC';
        v_nom_part := 'registro_gps_' || to_char(v_inicio_mes AT TIME ZONE 'UTC', 'YYYY_MM');

        v_creada := to_regclass('public.' || v_nom_part) IS NULL;

        IF v_creada THEN
            EXECUTE format(
                'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.registro_gps FOR VALUES FROM (%L) TO (%L);',
                v_nom_part,
                v_inicio_mes,
                v_fin_mes
            );

            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') THEN
                EXECUTE format('ALTER TABLE public.%I OWNER TO app_owner;', v_nom_part);
            END IF;
        END IF;

        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
            EXECUTE format('GRANT SELECT, INSERT ON TABLE public.%I TO app_user;', v_nom_part);
        END IF;

        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user_operations') THEN
            EXECUTE format('GRANT SELECT, INSERT ON TABLE public.%I TO app_user_operations;', v_nom_part);
        END IF;

        nombre_particion := v_nom_part;
        inicio_rango := v_inicio_mes;
        fin_rango := v_fin_mes;
        creada := v_creada;
        RETURN NEXT;
    END LOOP;
END;
$$;

-- 5. Función SECURITY DEFINER de purga por retención (180 días por defecto)
--    Desacopla y elimina únicamente particiones cuyo mes completo expiró.
CREATE OR REPLACE FUNCTION public.fn_purgar_particiones_gps_vencidas(
    p_dias_retencion INT DEFAULT 180,
    p_fecha_referencia TIMESTAMPTZ DEFAULT NOW()
)
RETURNS TABLE (
    nombre_particion TEXT,
    fecha_mes DATE,
    eliminada BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_fecha_limite TIMESTAMP WITHOUT TIME ZONE;
    v_mes_inicio DATE;
    v_mes_fin DATE;
    r RECORD;
BEGIN
    IF p_dias_retencion IS NULL OR p_dias_retencion < 30 THEN
        RAISE EXCEPTION 'PARAMETRO_INVALIDO: p_dias_retencion debe ser al menos 30 días.'
            USING ERRCODE = '22023';
    END IF;

    v_fecha_limite := (COALESCE(p_fecha_referencia, NOW()) AT TIME ZONE 'UTC')
        - (p_dias_retencion || ' days')::interval;

    FOR r IN (
        SELECT c.relname AS tabla_particion
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE i.inhparent = 'public.registro_gps'::regclass
          AND n.nspname = 'public'
        ORDER BY c.relname
    ) LOOP
        IF r.tabla_particion ~ '^registro_gps_[0-9]{4}_[0-9]{2}$' THEN
            v_mes_inicio := to_date(substring(r.tabla_particion FROM 14 FOR 7), 'YYYY_MM');
            v_mes_fin := (v_mes_inicio + INTERVAL '1 month')::date;

            IF v_mes_fin <= v_fecha_limite::date THEN
                EXECUTE format(
                    'ALTER TABLE public.registro_gps DETACH PARTITION public.%I;',
                    r.tabla_particion
                );
                EXECUTE format(
                    'DROP TABLE IF EXISTS public.%I;',
                    r.tabla_particion
                );

                nombre_particion := r.tabla_particion;
                fecha_mes := v_mes_inicio;
                eliminada := TRUE;
                RETURN NEXT;
            END IF;
        END IF;
    END LOOP;
END;
$$;

-- 6. Privilegios mínimos sobre las funciones de mantenimiento de particiones (OWASP ASVS V1.14)
REVOKE ALL ON FUNCTION public.fn_crear_particion_gps_mensual(TIMESTAMPTZ, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_purgar_particiones_gps_vencidas(INT, TIMESTAMPTZ) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        GRANT EXECUTE ON FUNCTION public.fn_crear_particion_gps_mensual(TIMESTAMPTZ, INT) TO app_user;
        GRANT EXECUTE ON FUNCTION public.fn_purgar_particiones_gps_vencidas(INT, TIMESTAMPTZ) TO app_user;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user_operations') THEN
        GRANT EXECUTE ON FUNCTION public.fn_crear_particion_gps_mensual(TIMESTAMPTZ, INT) TO app_user_operations;
    END IF;
END $$;

-- 7. Garantizar particiones del mes actual y los dos meses siguientes con permisos activos
SELECT * FROM public.fn_crear_particion_gps_mensual(NOW(), 2);

COMMIT;
