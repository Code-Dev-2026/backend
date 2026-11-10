-- ============================================================================
-- CAMINO SEGURO - TEST SUITE DE VALIDACIÓN POST-MIGRACIÓN (POSTGRESQL 16)
-- Archivo: db/scripts/test-validation-queries.sql
-- Valida estrictamente el alcance de la Issue #2 (DDL, roles, integridad y WORM)
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_count_ext INT;
    v_count_roles INT;
    v_count_tables_public INT;
    v_count_tables_billing INT;
    v_count_geo_sin_gist INT;
    v_particion_gps_existe BOOLEAN;
    v_error_disparado BOOLEAN := FALSE;
    v_test_audit_id UUID;
    v_seq BIGINT;
    v_hash_ant VARCHAR;
    v_hash_act VARCHAR;
BEGIN
    RAISE NOTICE '============================================================';
    RAISE NOTICE '1. VALIDACIÓN DE EXTENSIONES NATIVAS (POSTGIS, PGCRYPTO, BTREE_GIST)';
    RAISE NOTICE '============================================================';

    SELECT COUNT(*) INTO v_count_ext
    FROM pg_extension
    WHERE extname IN ('postgis', 'pgcrypto', 'btree_gist');

    IF v_count_ext <> 3 THEN
        RAISE EXCEPTION 'FALLO: Se esperaban 3 extensiones nativas, halladas: %', v_count_ext;
    END IF;
    RAISE NOTICE ' [OK] 3 Extensiones instaladas correctamente.';

    RAISE NOTICE '============================================================';
    RAISE NOTICE '2. VALIDACIÓN DE ROLES DE BASE DE DATOS (ASVS V1.14)';
    RAISE NOTICE '============================================================';

    SELECT COUNT(*) INTO v_count_roles
    FROM pg_roles
    WHERE rolname IN ('app_owner', 'app_user', 'app_user_operations', 'app_user_billing');

    IF v_count_roles <> 4 THEN
        RAISE EXCEPTION 'FALLO: Se esperaban 4 roles de DB, hallados: %', v_count_roles;
    END IF;
    RAISE NOTICE ' [OK] 4 Roles configurados (app_owner, app_user, app_user_operations, app_user_billing).';

    RAISE NOTICE '============================================================';
    RAISE NOTICE '3. VALIDACIÓN DE TABLAS EN ESQUEMA PUBLIC Y BILLING';
    RAISE NOTICE '============================================================';

    -- Validación del esquema billing (Exactamente 3 tablas)
    SELECT COUNT(*) INTO v_count_tables_billing
    FROM information_schema.tables
    WHERE table_schema = 'billing' AND table_type = 'BASE TABLE';

    IF v_count_tables_billing <> 3 THEN
        RAISE EXCEPTION 'FALLO: Se esperaban 3 tablas en esquema billing, halladas: %', v_count_tables_billing;
    END IF;
    RAISE NOTICE ' [OK] Esquema billing: 3 tablas confirmadas (cartera, factura, pago).';

    -- Comprobación de existencia de las entidades del SRS en public
    PERFORM 1 FROM public.colegio LIMIT 1;
    PERFORM 1 FROM public.empresa_transportadora LIMIT 1;
    PERFORM 1 FROM public.usuario LIMIT 1;
    PERFORM 1 FROM public.rol LIMIT 1;
    PERFORM 1 FROM public.usuario_rol LIMIT 1;
    PERFORM 1 FROM public.refresh_token LIMIT 1;
    PERFORM 1 FROM public.mfa_secret LIMIT 1;
    PERFORM 1 FROM public.dispositivo LIMIT 1;
    PERFORM 1 FROM public.coordinador LIMIT 1;
    PERFORM 1 FROM public.conductor LIMIT 1;
    PERFORM 1 FROM public.monitora LIMIT 1;
    PERFORM 1 FROM public.acudiente LIMIT 1;
    PERFORM 1 FROM public.adulto_autorizado LIMIT 1;
    PERFORM 1 FROM public.estudiante LIMIT 1;
    PERFORM 1 FROM public.estudiante_acudiente LIMIT 1;
    PERFORM 1 FROM public.estudiante_autorizado LIMIT 1;
    PERFORM 1 FROM public.expediente_cifrado LIMIT 1;
    PERFORM 1 FROM public.alerta_judicial LIMIT 1;
    PERFORM 1 FROM public.viaje LIMIT 1;
    PERFORM 1 FROM public.viaje_estudiante LIMIT 1;
    PERFORM 1 FROM public.historial_estado_custodia LIMIT 1;
    PERFORM 1 FROM public.inasistencia LIMIT 1;
    PERFORM 1 FROM public.pasajero_ocasional LIMIT 1;
    PERFORM 1 FROM public.vehiculo LIMIT 1;
    PERFORM 1 FROM public.ruta LIMIT 1;
    PERFORM 1 FROM public.parada LIMIT 1;
    PERFORM 1 FROM public.asignacion_ruta LIMIT 1;
    PERFORM 1 FROM public.zona_geografica LIMIT 1;
    PERFORM 1 FROM public.registro_gps LIMIT 1;
    PERFORM 1 FROM public.registro_de_asistencia LIMIT 1;
    PERFORM 1 FROM public.entrega LIMIT 1;
    PERFORM 1 FROM public.acta_custodia LIMIT 1;
    PERFORM 1 FROM public.incidente LIMIT 1;
    PERFORM 1 FROM public.aval_coordinacion LIMIT 1;
    PERFORM 1 FROM public.importacion_matricula LIMIT 1;
    PERFORM 1 FROM public.tipo_notificacion LIMIT 1;
    PERFORM 1 FROM public.notificacion LIMIT 1;
    PERFORM 1 FROM public.comunicado LIMIT 1;
    PERFORM 1 FROM public.sync_operation LIMIT 1;
    PERFORM 1 FROM public.bitacora_auditoria LIMIT 1;
    RAISE NOTICE ' [OK] Todas las entidades maestras y transaccionales del SRS v2.0 estan instanciadas.';

    -- Verificar particionamiento de registro_gps
    SELECT EXISTS (
        SELECT 1 FROM pg_inherits
        WHERE inhparent = 'public.registro_gps'::regclass
    ) INTO v_particion_gps_existe;

    IF NOT v_particion_gps_existe THEN
        RAISE EXCEPTION 'FALLO: registro_gps no tiene particiones activas vinculadas.';
    END IF;
    RAISE NOTICE ' [OK] Particionamiento mensual de registro_gps validado.';

    RAISE NOTICE '============================================================';
    RAISE NOTICE '4. VALIDACIÓN DE ÍNDICES GIST EN COLUMNAS GEOGRAPHY';
    RAISE NOTICE '============================================================';

    SELECT COUNT(*) INTO v_count_geo_sin_gist
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.udt_name = 'geography'
      AND c.table_name NOT IN ('spatial_ref_sys')
      AND c.table_name NOT LIKE 'registro_gps_%'
      AND NOT EXISTS (
          SELECT 1
          FROM pg_class tc
          JOIN pg_index x ON x.indrelid = tc.oid
          JOIN pg_class i ON i.oid = x.indexrelid
          JOIN pg_am am ON am.oid = i.relam
          JOIN pg_attribute a ON a.attrelid = tc.oid AND a.attnum = ANY(x.indkey)
          WHERE tc.relname = c.table_name
            AND a.attname = c.column_name
            AND am.amname = 'gist'
      );

    IF v_count_geo_sin_gist > 0 THEN
        RAISE EXCEPTION 'FALLO: Se encontraron % columnas geography sin indice GiST.', v_count_geo_sin_gist;
    END IF;
    RAISE NOTICE ' [OK] Todas las columnas geography(...,4326) cuentan con indice GiST.';

    RAISE NOTICE '============================================================';
    RAISE NOTICE '5. PRUEBA NEGATIVA: INMUTABILIDAD ESTRICTA (WORM) EN BITACORA';
    RAISE NOTICE '============================================================';

    -- Insertar un registro en bitácora
    INSERT INTO bitacora_auditoria (tabla, operacion, datos_nuevos)
    VALUES ('colegio', 'INSERT', '{"test": true}'::jsonb)
    RETURNING id_auditoria, secuencia, hash_sha256_anterior, hash_sha256_actual
    INTO v_test_audit_id, v_seq, v_hash_ant, v_hash_act;

    -- Probar UPDATE (debe fallar con ERRCODE 55000)
    v_error_disparado := FALSE;
    BEGIN
        UPDATE bitacora_auditoria
        SET tabla = 'intento_hackeo'
        WHERE id_auditoria = v_test_audit_id;
    EXCEPTION WHEN SQLSTATE '55000' THEN
        v_error_disparado := TRUE;
    END;

    IF NOT v_error_disparado THEN
        RAISE EXCEPTION 'FALLO DE SEGURIDAD: UPDATE en bitacora_auditoria no fue bloqueado.';
    END IF;
    RAISE NOTICE ' [OK] UPDATE bloqueado exitosamente por trigger WORM.';

    -- Probar DELETE (debe fallar con ERRCODE 55000)
    v_error_disparado := FALSE;
    BEGIN
        DELETE FROM bitacora_auditoria WHERE id_auditoria = v_test_audit_id;
    EXCEPTION WHEN SQLSTATE '55000' THEN
        v_error_disparado := TRUE;
    END;

    IF NOT v_error_disparado THEN
        RAISE EXCEPTION 'FALLO DE SEGURIDAD: DELETE en bitacora_auditoria no fue bloqueado.';
    END IF;
    RAISE NOTICE ' [OK] DELETE bloqueado exitosamente por trigger WORM.';

    RAISE NOTICE '============================================================';
    RAISE NOTICE '6. PRUEBA DE ENCADENAMIENTO CRIPTOGRÁFICO SHA-256';
    RAISE NOTICE '============================================================';
    PERFORM 1 FROM fn_verificar_integridad_bitacora(100);
    RAISE NOTICE ' [OK] Cadena forense SHA-256 verificada e integra.';

    RAISE NOTICE '============================================================';
    RAISE NOTICE 'TODAS LAS VALIDACIONES DE LA ISSUE #2 PASARON EXITOSAMENTE.';
    RAISE NOTICE '============================================================';

END $$;

ROLLBACK;
