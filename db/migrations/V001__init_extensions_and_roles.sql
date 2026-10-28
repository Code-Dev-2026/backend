-- ============================================================================
-- MIGRACIÓN V001: EXTENSIONES, GENERADOR UUIDv7, DOMINIO CIFRADO Y ROLES BASE
-- ============================================================================
BEGIN;

CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- Roles de Base de Datos sin contraseñas (provistas dinámicamente por Secrets Manager)
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_owner') THEN
        CREATE ROLE app_owner NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
        CREATE ROLE app_user WITH LOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user_operations') THEN
        CREATE ROLE app_user_operations WITH LOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user_billing') THEN
        CREATE ROLE app_user_billing WITH LOGIN;
    END IF;
END $$;

-- Dominio estricto para formato unificado de cifrado en reposo (AES-256-GCM)
-- Formato: key_version:iv_b64:tag_b64:ciphertext_b64
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'formato_cifrado_aes') THEN
        CREATE DOMAIN formato_cifrado_aes AS TEXT
            CHECK (VALUE ~ '^v[0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$');
    END IF;
END $$;

-- Generador Nativo UUIDv7 (RFC 9562): Ordenado cronológicamente, previene IDOR
CREATE OR REPLACE FUNCTION fn_uuid_generate_v7()
RETURNS uuid AS $$
DECLARE
    v_time_ms bigint;
    v_bytes bytea;
BEGIN
    v_time_ms := (extract(epoch from clock_timestamp()) * 1000)::bigint;
    v_bytes := gen_random_bytes(16);
    v_bytes := set_byte(v_bytes, 0, (v_time_ms >> 40)::integer);
    v_bytes := set_byte(v_bytes, 1, (v_time_ms >> 32)::integer);
    v_bytes := set_byte(v_bytes, 2, (v_time_ms >> 24)::integer);
    v_bytes := set_byte(v_bytes, 3, (v_time_ms >> 16)::integer);
    v_bytes := set_byte(v_bytes, 4, (v_time_ms >> 8)::integer);
    v_bytes := set_byte(v_bytes, 5, (v_time_ms)::integer);
    v_bytes := set_byte(v_bytes, 6, (get_byte(v_bytes, 6) & 15) | 112); -- Version 7 (0111)
    v_bytes := set_byte(v_bytes, 8, (get_byte(v_bytes, 8) & 63) | 128); -- Variant 1 (10)
    RETURN encode(v_bytes, 'hex')::uuid;
END;
$$ LANGUAGE plpgsql VOLATILE;

COMMIT;
