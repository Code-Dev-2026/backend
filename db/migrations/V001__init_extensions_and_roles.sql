-- ============================================================================
-- CAMINO SEGURO - BACKEND CORE DDL (POSTGRESQL 16 + POSTGIS 3.4)
-- Archivo: V001__init_extensions_and_roles.sql
-- Subdominio: Extensiones del Motor, Roles de Base de Datos, Dominio Criptográfico y Generador UUIDv7
-- Estándar: Flyway / OWASP ASVS V1.14 / Ley Estatutaria 1581 de 2012
-- ============================================================================

BEGIN;

-- 1. EXTENSIONES DEL MOTOR NATIVO (POSTGIS, PGCRYPTO, BTREE_GIST)
CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- 2. ROLES DE BASE DE DATOS SIN CREDENCIALES QUEMADAS (ASVS V1.14)
-- Las contraseñas operativas son provistas por Secrets Manager / variables de entorno
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

-- 3. DOMINIO PARA FORMATO UNIFICADO DE CIFRADO EN REPOSO (AES-256-GCM)
-- Estructura canónica: key_version:iv_b64:tag_b64:ciphertext_b64
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'formato_cifrado_aes') THEN
        CREATE DOMAIN formato_cifrado_aes AS TEXT
            CHECK (VALUE ~ '^v[0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$');
    END IF;
END $$;

-- 4. GENERADOR NATIVO UUIDv7 (RFC 9562)
-- Identificadores ordenados cronológicamente por milisegundo UTC, optimizando índices B-Tree y mitigando IDOR
CREATE OR REPLACE FUNCTION fn_uuid_generate_v7()
RETURNS uuid AS $$
DECLARE
    v_time_ms BIGINT;
    v_bytes BYTEA;
BEGIN
    v_time_ms := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT;
    v_bytes := gen_random_bytes(16);
    v_bytes := set_byte(v_bytes, 0, ((v_time_ms >> 40) & 255)::INTEGER);
    v_bytes := set_byte(v_bytes, 1, ((v_time_ms >> 32) & 255)::INTEGER);
    v_bytes := set_byte(v_bytes, 2, ((v_time_ms >> 24) & 255)::INTEGER);
    v_bytes := set_byte(v_bytes, 3, ((v_time_ms >> 16) & 255)::INTEGER);
    v_bytes := set_byte(v_bytes, 4, ((v_time_ms >> 8) & 255)::INTEGER);
    v_bytes := set_byte(v_bytes, 5, (v_time_ms & 255)::INTEGER);
    v_bytes := set_byte(v_bytes, 6, (get_byte(v_bytes, 6) & 15) | 112); -- Versión 7 (0111)
    v_bytes := set_byte(v_bytes, 8, (get_byte(v_bytes, 8) & 63) | 128); -- Variante 1 (10)
    RETURN encode(v_bytes, 'hex')::uuid;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- Alias de compatibilidad canónico
CREATE OR REPLACE FUNCTION uuid_generate_v7()
RETURNS uuid AS $$
BEGIN
    RETURN fn_uuid_generate_v7();
END;
$$ LANGUAGE plpgsql VOLATILE;

COMMIT;

