-- ============================================================================
-- CAMINO SEGURO - BACKEND CORE DDL (POSTGRESQL 16 + POSTGIS 3.4)
-- Archivo: V010__security_rls_and_permissions.sql
-- Subdominio: Gobernanza de Seguridad ASVS V1.14, Asignación de Roles y Privilegios Mínimos
-- Requisitos SRS: RNF-01, RNF-02, OWASP ASVS V1.14
-- ============================================================================

BEGIN;

-- 1. ASIGNACIÓN DE PROPIEDAD DDL EXCLUSIVA A app_owner
DO $$
DECLARE
    r RECORD;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') THEN
        -- Transferir propiedad de esquemas
        ALTER SCHEMA public OWNER TO app_owner;
        IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'billing') THEN
            ALTER SCHEMA billing OWNER TO app_owner;
        END IF;

        -- Transferir tablas del esquema public
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
            EXECUTE format('ALTER TABLE public.%I OWNER TO app_owner;', r.tablename);
        END LOOP;

        -- Transferir tablas del esquema billing
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'billing') LOOP
            EXECUTE format('ALTER TABLE billing.%I OWNER TO app_owner;', r.tablename);
        END LOOP;

        -- Transferir secuencias
        FOR r IN (SELECT sequence_name, sequence_schema FROM information_schema.sequences WHERE sequence_schema IN ('public', 'billing')) LOOP
            EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO app_owner;', r.sequence_schema, r.sequence_name);
        END LOOP;
    END IF;
END $$;

-- 2. REVOCACIÓN PREVENTIVA DE PRIVILEGIOS PÚBLICOS (Zero-Trust)
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'billing') THEN
        REVOKE ALL ON SCHEMA billing FROM PUBLIC;
    END IF;
END $$;

-- 3. ASIGNACIÓN DE PRIVILEGIOS MÍNIMOS POR ROL DE DB (OWASP ASVS V1.14)
DO $$
BEGIN
    -- ------------------------------------------------------------------------
    -- ROL: app_user (Conexión operativa estándar de la API)
    -- ------------------------------------------------------------------------
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        GRANT USAGE ON SCHEMA public TO app_user;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;

        -- Revocaciones de inmutabilidad estricta (WORM)
        REVOKE UPDATE, DELETE, TRUNCATE ON public.bitacora_auditoria FROM app_user;
        REVOKE UPDATE, DELETE, TRUNCATE ON public.historial_estado_custodia FROM app_user;

        -- Aislamiento de facturación
        IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'billing') THEN
            REVOKE ALL ON SCHEMA billing FROM app_user;
        END IF;
    END IF;

    -- ------------------------------------------------------------------------
    -- ROL: app_user_operations (Servicio de telemetría IoT, conductores y monitoras)
    -- ------------------------------------------------------------------------
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user_operations') THEN
        GRANT USAGE ON SCHEMA public TO app_user_operations;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user_operations;

        -- Lectura en entidades maestras y catálogos
        GRANT SELECT ON public.colegio, public.usuario, public.rol, public.conductor,
                        public.coordinador, public.vehiculo, public.empresa_transportadora,
                        public.ruta, public.parada, public.zona_geografica, public.estudiante,
                        public.estudiante_acudiente, public.adulto_autorizado, public.estudiante_autorizado,
                        public.asignacion_ruta, public.pasajero_ocasional, public.tipo_notificacion,
                        public.expediente_cifrado, public.alerta_judicial
            TO app_user_operations;

        -- Escritura transaccional operativa
        GRANT SELECT, INSERT, UPDATE ON public.viaje, public.viaje_estudiante,
                                        public.registro_de_asistencia, public.entrega,
                                        public.acta_custodia, public.incidente,
                                        public.aval_coordinacion, public.sync_operation,
                                        public.inasistencia, public.dispositivo
            TO app_user_operations;

        -- Append-Only en telemetría continua y custodia
        GRANT SELECT, INSERT ON public.registro_gps, public.historial_estado_custodia TO app_user_operations;

        -- Bloqueo absoluto de acceso al esquema financiero
        IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'billing') THEN
            REVOKE ALL ON SCHEMA billing FROM app_user_operations;
        END IF;
    END IF;

    -- ------------------------------------------------------------------------
    -- ROL: app_user_billing (Servicio administrativo de cartera y recaudo)
    -- ------------------------------------------------------------------------
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user_billing') THEN
        GRANT USAGE ON SCHEMA public TO app_user_billing;
        GRANT SELECT ON public.estudiante, public.acudiente, public.estudiante_acudiente TO app_user_billing;

        IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'billing') THEN
            GRANT USAGE ON SCHEMA billing TO app_user_billing;
            GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA billing TO app_user_billing;
            GRANT SELECT, INSERT, UPDATE ON billing.cartera, billing.factura, billing.pago TO app_user_billing;
        END IF;
    END IF;
END $$;

COMMIT;
