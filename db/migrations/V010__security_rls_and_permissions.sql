-- ============================================================================
-- CAMINO SEGURO - MOTOR CORE & CUSTODIA (COLEGIO SAN BENITO DEL OTÚN)
-- V010__security_rls_and_permissions.sql
-- Sub-sistemas: Gobernanza de Seguridad ASVS L2, Asignación de Roles,
--               Privilegios Mínimos y Políticas de Row-Level Security (RLS)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. ASIGNACIÓN DE PROPIETARIO DDL (app_owner)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    r RECORD;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') THEN
        -- Tablas esquema public
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
            EXECUTE format('ALTER TABLE public.%I OWNER TO app_owner;', r.tablename);
        END LOOP;

        -- Tablas esquema billing
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'billing') LOOP
            EXECUTE format('ALTER TABLE billing.%I OWNER TO app_owner;', r.tablename);
        END LOOP;

        -- Tipos y dominios
        ALTER SCHEMA public OWNER TO app_owner;
        ALTER SCHEMA billing OWNER TO app_owner;
    END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. PRIVILEGIOS MÍNIMOS POR ROL DE APLICACIÓN
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        GRANT USAGE ON SCHEMA public TO app_user;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
        GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app_user;
        -- Revocaciones estrictas de inmutabilidad
        REVOKE UPDATE, DELETE, TRUNCATE ON public.bitacora_auditoria FROM app_user;
        REVOKE UPDATE, DELETE, TRUNCATE ON public.historial_estado_custodia FROM app_user;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user_operations') THEN
        GRANT USAGE ON SCHEMA public TO app_user_operations;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user_operations;
        GRANT SELECT ON public.colegio, public.usuario, public.rol, public.conductor,
                        public.coordinador, public.vehiculo, public.empresa_transportadora,
                        public.ruta, public.parada, public.zona_geografica, public.estudiante,
                        public.estudiante_acudiente, public.adulto_autorizado, public.estudiante_autorizado,
                        public.asignacion_ruta, public.pasajero_ocasional, public.tipo_notificacion
            TO app_user_operations;
        GRANT SELECT, INSERT, UPDATE ON public.viaje, public.registro_de_asistencia,
                                        public.entrega, public.incidente, public.sync_operation
            TO app_user_operations;
        GRANT SELECT, INSERT ON public.registro_gps, public.historial_estado_custodia TO app_user_operations;

        -- Bloqueo absoluto de acceso financiero
        REVOKE ALL ON SCHEMA billing FROM app_user_operations;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user_billing') THEN
        GRANT USAGE ON SCHEMA public TO app_user_billing;
        GRANT USAGE ON SCHEMA billing TO app_user_billing;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA billing TO app_user_billing;
        GRANT SELECT ON public.estudiante, public.acudiente, public.estudiante_acudiente TO app_user_billing;
        GRANT SELECT, INSERT, UPDATE ON billing.cartera, billing.factura, billing.pago TO app_user_billing;
    END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3. POLÍTICAS DE ROW-LEVEL SECURITY (RLS) - AISLAMIENTO FAMILIAR (RNF-02)
--    Contexto de sesión:
--      SET LOCAL app.current_user_id = 'uuid-del-usuario';
--      SET LOCAL app.current_user_role = 'ACUDIENTE' | 'ADMIN' | 'MONITORA' ...
-- ----------------------------------------------------------------------------

-- Habilitar RLS en tablas expuestas a acudientes
ALTER TABLE public.estudiante ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estudiante FORCE ROW LEVEL SECURITY;

ALTER TABLE public.registro_gps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.registro_gps FORCE ROW LEVEL SECURITY;

ALTER TABLE public.notificacion ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notificacion FORCE ROW LEVEL SECURITY;

ALTER TABLE billing.cartera ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.cartera FORCE ROW LEVEL SECURITY;

ALTER TABLE billing.factura ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.factura FORCE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- Políticas en public.estudiante
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS p_estudiante_acceso ON public.estudiante;
CREATE POLICY p_estudiante_acceso ON public.estudiante
FOR SELECT TO PUBLIC
USING (
    COALESCE(current_setting('app.current_user_role', true), '') IN ('ADMIN', 'SUPERADMIN', 'COORDINADOR', 'MONITORA', 'CONDUCTOR')
    OR (
        COALESCE(current_setting('app.current_user_role', true), '') = 'ACUDIENTE'
        AND id_estudiante IN (
            SELECT ea.id_estudiante
            FROM public.estudiante_acudiente ea
            JOIN public.acudiente a ON ea.id_acudiente = a.id_acudiente
            WHERE a.id_usuario = NULLIF(current_setting('app.current_user_id', true), '')::UUID
        )
    )
);

-- ----------------------------------------------------------------------------
-- Políticas en public.registro_gps (Telemetría en vivo condicional: RF-10)
-- El acudiente solo accede al stream GPS si su hijo está A_BORDO_VEHICULO
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS p_registro_gps_acceso ON public.registro_gps;
CREATE POLICY p_registro_gps_acceso ON public.registro_gps
FOR SELECT TO PUBLIC
USING (
    COALESCE(current_setting('app.current_user_role', true), '') IN ('ADMIN', 'SUPERADMIN', 'COORDINADOR', 'MONITORA', 'CONDUCTOR')
    OR (
        COALESCE(current_setting('app.current_user_role', true), '') = 'ACUDIENTE'
        AND id_viaje IN (
            SELECT v.id_viaje
            FROM public.viaje v
            JOIN public.asignacion_ruta ar ON ar.id_ruta = v.id_ruta
            JOIN public.estudiante_acudiente ea ON ea.id_estudiante = ar.id_estudiante
            JOIN public.acudiente a ON ea.id_acudiente = a.id_acudiente
            WHERE a.id_usuario = NULLIF(current_setting('app.current_user_id', true), '')::UUID
              AND v.estado = 'EN_CURSO'
              AND EXISTS (
                  -- Condición RF-10: solo mientras el menor esté físicamente a bordo
                  SELECT 1 FROM public.viaje_estudiante ve
                  WHERE ve.id_viaje = v.id_viaje
                    AND ve.id_estudiante = ar.id_estudiante
                    AND ve.estado_custodia = 'A_BORDO_VEHICULO'
              )
        )
    )
);

-- ----------------------------------------------------------------------------
-- Políticas en public.notificacion
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS p_notificacion_acceso ON public.notificacion;
CREATE POLICY p_notificacion_acceso ON public.notificacion
FOR ALL TO PUBLIC
USING (
    COALESCE(current_setting('app.current_user_role', true), '') IN ('ADMIN', 'SUPERADMIN', 'COORDINADOR')
    OR (
        COALESCE(current_setting('app.current_user_role', true), '') = 'ACUDIENTE'
        AND id_acudiente IN (
            SELECT a.id_acudiente
            FROM public.acudiente a
            WHERE a.id_usuario = NULLIF(current_setting('app.current_user_id', true), '')::UUID
        )
    )
);

-- ----------------------------------------------------------------------------
-- Políticas en billing.cartera y billing.factura
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS p_cartera_acceso ON billing.cartera;
CREATE POLICY p_cartera_acceso ON billing.cartera
FOR SELECT TO PUBLIC
USING (
    COALESCE(current_setting('app.current_user_role', true), '') IN ('ADMIN', 'SUPERADMIN', 'COORDINADOR', 'FINANZAS')
    OR (
        COALESCE(current_setting('app.current_user_role', true), '') = 'ACUDIENTE'
        AND id_acudiente_titular IN (
            SELECT a.id_acudiente
            FROM public.acudiente a
            WHERE a.id_usuario = NULLIF(current_setting('app.current_user_id', true), '')::UUID
        )
    )
);

DROP POLICY IF EXISTS p_factura_acceso ON billing.factura;
CREATE POLICY p_factura_acceso ON billing.factura
FOR SELECT TO PUBLIC
USING (
    COALESCE(current_setting('app.current_user_role', true), '') IN ('ADMIN', 'SUPERADMIN', 'COORDINADOR', 'FINANZAS')
    OR (
        COALESCE(current_setting('app.current_user_role', true), '') = 'ACUDIENTE'
        AND id_cartera IN (
            SELECT c.id_cartera
            FROM billing.cartera c
            JOIN public.acudiente a ON c.id_acudiente_titular = a.id_acudiente
            WHERE a.id_usuario = NULLIF(current_setting('app.current_user_id', true), '')::UUID
        )
    )
);
