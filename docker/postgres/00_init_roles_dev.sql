-- ============================================================================
-- CAMINO SEGURO - CONFIGURACIÓN DE ROLES PARA AMBIENTE DE DESARROLLO LOCAL
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_owner') THEN
        CREATE ROLE app_owner WITH LOGIN SUPERUSER PASSWORD 'dev_owner_password_san_benito_2026';
    ELSE
        ALTER ROLE app_owner WITH LOGIN SUPERUSER PASSWORD 'dev_owner_password_san_benito_2026';
    END IF;

    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
        CREATE ROLE app_user WITH LOGIN PASSWORD 'dev_app_user_password_2026';
    ELSE
        ALTER ROLE app_user WITH LOGIN PASSWORD 'dev_app_user_password_2026';
    END IF;

    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user_operations') THEN
        CREATE ROLE app_user_operations WITH LOGIN PASSWORD 'dev_app_user_password_2026';
    ELSE
        ALTER ROLE app_user_operations WITH LOGIN PASSWORD 'dev_app_user_password_2026';
    END IF;

    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user_billing') THEN
        CREATE ROLE app_user_billing WITH LOGIN PASSWORD 'dev_app_user_password_2026';
    ELSE
        ALTER ROLE app_user_billing WITH LOGIN PASSWORD 'dev_app_user_password_2026';
    END IF;
END $$;
