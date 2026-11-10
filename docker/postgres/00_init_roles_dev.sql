-- ============================================================================
-- CAMINO SEGURO - INICIALIZACIÓN DE ROLES EN ENTORNO DE DESARROLLO LOCAL
-- Este script se ejecuta en docker-entrypoint-initdb.d para configurar contraseñas
-- desde variables de entorno provistas al contenedor (.env) sin quemarlas en el código.
-- ============================================================================

\getenv APP_USER_PASSWORD APP_USER_PASSWORD
\getenv APP_USER_OPERATIONS_PASSWORD APP_USER_OPERATIONS_PASSWORD
\getenv APP_USER_BILLING_PASSWORD APP_USER_BILLING_PASSWORD

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_owner') THEN
        CREATE ROLE app_owner WITH NOLOGIN;
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

-- Asignación dinámica de contraseñas desde variables de entorno sin credenciales quemadas
ALTER ROLE app_user WITH PASSWORD :'APP_USER_PASSWORD';
ALTER ROLE app_user_operations WITH PASSWORD :'APP_USER_OPERATIONS_PASSWORD';
ALTER ROLE app_user_billing WITH PASSWORD :'APP_USER_BILLING_PASSWORD';
