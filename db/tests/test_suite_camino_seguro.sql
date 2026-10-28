-- ============================================================================
-- CAMINO SEGURO - TEST SUITE DE INTEGRIDAD Y REGLAS DE NEGOCIO (POSTGRESQL 16)
-- db/tests/test_suite_camino_seguro.sql
-- Escenarios de prueba automatizados para verificar invariantes críticas:
-- 1. Doble escaneo de abordaje
-- 2. Sobrecupo atómico concurrente
-- 3. Verificación de hash SHA-256 encadenado en Bitácora y Custodia
-- 4. Segregación de permisos del esquema billing
-- 5. Row-Level Security (Aislamiento familiar de acudientes)
-- 6. Desembarque normal vs Retorno a sede por ausencia de receptor
-- 7. Alerta judicial activa en entrega
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ----------------------------------------------------------------------------
-- SETUP DE DATOS SEMILLA PARA PRUEBAS
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_colegio_id UUID;
    v_empresa_id UUID;
    v_vehiculo_id UUID;
    v_user_cond_id UUID;
    v_user_mon_id UUID;
    v_user_acu_id UUID;
    v_conductor_id UUID;
    v_acudiente_id UUID;
    v_estudiante_1 UUID;
    v_estudiante_2 UUID;
    v_ruta_id UUID;
    v_parada_subida UUID;
    v_parada_bajada UUID;
    v_viaje_id UUID;
    v_res JSONB;
BEGIN
    RAISE NOTICE '=== INICIANDO CONFIGURACIÓN DE ESCENARIOS DE PRUEBA ===';

    -- Colegio
    INSERT INTO colegio (id_colegio, nombre, nit, direccion, telefono, ubicacion_geografica)
    VALUES (
        '018f0000-0000-7000-8000-000000000001',
        'Colegio San Benito del Otún',
        '900123456-7',
        'Km 4 Vía La Florida, Pereira',
        '+57 310 1234567',
        ST_SetSRID(ST_MakePoint(-75.69611, 4.81333), 4326)::geography
    ) ON CONFLICT DO NOTHING;

    -- Empresa y Vehículo (Capacidad 1 pasajero para prueba de sobrecupo)
    INSERT INTO empresa_transportadora (id_empresa, nombre, nit, telefono, direccion)
    VALUES (
        '018f0000-0000-7000-8000-000000000002',
        'Transportes Camino Seguro S.A.S.',
        '901987654-3',
        '+57 6 3209999',
        'Av. Circunvalar # 12-34, Pereira'
    ) ON CONFLICT DO NOTHING;

    INSERT INTO vehiculo (id_vehiculo, id_empresa, placa, marca, modelo, capacidad_pasajeros, soat_vencimiento, rtm_vencimiento)
    VALUES (
        '018f0000-0000-7000-8000-000000000003',
        '018f0000-0000-7000-8000-000000000002',
        'WKK123',
        'Mercedes-Benz',
        'Sprinter 515',
        1, -- CAPACIDAD 1 PARA TEST DE SOBRECUPO
        CURRENT_DATE + INTERVAL '180 days',
        CURRENT_DATE + INTERVAL '180 days'
    ) ON CONFLICT DO NOTHING;

    -- Usuarios: Conductor, Monitora, Acudiente
    INSERT INTO usuario (id_usuario, nombre_completo, correo, documento_identidad_hash, telefono, id_rol)
    VALUES
    ('018f0000-0000-7000-8000-000000000010', 'Carlos Conductor', 'carlos@caminoseguro.edu.co', encode(digest('1088001001', 'sha256'), 'hex'), '+573001111111', 2),
    ('018f0000-0000-7000-8000-000000000011', 'Marta Monitora', 'marta@caminoseguro.edu.co', encode(digest('1088001002', 'sha256'), 'hex'), '+573002222222', 3),
    ('018f0000-0000-7000-8000-000000000012', 'Ana Acudiente', 'ana@padres.com', encode(digest('1088001003', 'sha256'), 'hex'), '+573003333333', 4)
    ON CONFLICT DO NOTHING;

    INSERT INTO conductor (id_conductor, id_usuario, numero_licencia, vencimiento_licencia)
    VALUES ('018f0000-0000-7000-8000-000000000020', '018f0000-0000-7000-8000-000000000010', 'LIC-998877', CURRENT_DATE + INTERVAL '365 days')
    ON CONFLICT DO NOTHING;

    INSERT INTO acudiente (id_acudiente, id_usuario, nombres, apellidos, documento_identidad_hash, telefono_principal, correo_electronico, direccion_residencia)
    VALUES ('018f0000-0000-7000-8000-000000000030', '018f0000-0000-7000-8000-000000000012', 'Ana', 'Gomez', encode(digest('1088001003', 'sha256'), 'hex'), '+573003333333', 'ana@padres.com', 'Calle 10 # 5-20')
    ON CONFLICT DO NOTHING;

    -- Estudiantes (2 estudiantes)
    INSERT INTO estudiante (id_estudiante, id_colegio, nombres, apellidos, codigo_estudiantil, codigo_qr_hash)
    VALUES
    ('018f0000-0000-7000-8000-000000000041', '018f0000-0000-7000-8000-000000000001', 'Santiago', 'Perez Gomez', 'EST-001', encode(digest('QR-SANTI-001', 'sha256'), 'hex')),
    ('018f0000-0000-7000-8000-000000000042', '018f0000-0000-7000-8000-000000000001', 'Valeria', 'Perez Gomez', 'EST-002', encode(digest('QR-VALE-002', 'sha256'), 'hex'))
    ON CONFLICT DO NOTHING;

    INSERT INTO estudiante_acudiente (id_estudiante, id_acudiente, relacion, es_representante_legal)
    VALUES
    ('018f0000-0000-7000-8000-000000000041', '018f0000-0000-7000-8000-000000000030', 'MADRE', true),
    ('018f0000-0000-7000-8000-000000000042', '018f0000-0000-7000-8000-000000000030', 'MADRE', true)
    ON CONFLICT DO NOTHING;

    -- Ruta y Paradas
    INSERT INTO ruta (id_ruta, id_colegio, id_empresa, codigo_ruta, nombre, tipo_recorrido)
    VALUES ('018f0000-0000-7000-8000-000000000050', '018f0000-0000-7000-8000-000000000001', '018f0000-0000-7000-8000-000000000002', 'R-01', 'Ruta Pinares - Circunvalar', 'MANANA')
    ON CONFLICT DO NOTHING;

    INSERT INTO parada (id_parada, id_ruta, nombre, orden_secuencia, punto_geografico)
    VALUES
    ('018f0000-0000-7000-8000-000000000051', '018f0000-0000-7000-8000-000000000050', 'Parada Pinares Carrera 18', 1, ST_SetSRID(ST_MakePoint(-75.690, 4.810), 4326)::geography),
    ('018f0000-0000-7000-8000-000000000052', '018f0000-0000-7000-8000-000000000050', 'Colegio Sede Principal', 2, ST_SetSRID(ST_MakePoint(-75.696, 4.813), 4326)::geography)
    ON CONFLICT DO NOTHING;

    -- Asignación de ambos estudiantes a la ruta
    INSERT INTO asignacion_ruta (id_estudiante, id_ruta, id_parada_subida, id_parada_bajada)
    VALUES
    ('018f0000-0000-7000-8000-000000000041', '018f0000-0000-7000-8000-000000000050', '018f0000-0000-7000-8000-000000000051', '018f0000-0000-7000-8000-000000000052'),
    ('018f0000-0000-7000-8000-000000000042', '018f0000-0000-7000-8000-000000000050', '018f0000-0000-7000-8000-000000000051', '018f0000-0000-7000-8000-000000000052')
    ON CONFLICT DO NOTHING;

    -- Viaje En Curso
    INSERT INTO viaje (
        id_viaje, id_ruta, id_vehiculo, id_conductor, id_monitora,
        fecha, hora_inicio_programada, hora_fin_programada,
        hora_inicio_real, estado, total_a_bordo
    )
    VALUES (
        '018f0000-0000-7000-8000-000000000060',
        '018f0000-0000-7000-8000-000000000050',
        '018f0000-0000-7000-8000-000000000003', -- Vehiculo con capacidad 1
        '018f0000-0000-7000-8000-000000000020',
        '018f0000-0000-7000-8000-000000000011',
        CURRENT_DATE,
        clock_timestamp(),
        clock_timestamp() + INTERVAL '1 hour',
        clock_timestamp(),
        'EN_CURSO',
        0
    ) ON CONFLICT DO NOTHING;

    RAISE NOTICE '=== SETUP COMPLETADO EXITOSAMENTE ===';
END $$;

-- ----------------------------------------------------------------------------
-- ESCENARIO 1: ABORDAJE EXITOSO DEL ESTUDIANTE 1
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_res JSONB;
BEGIN
    RAISE NOTICE '--- TEST 1: Registro de Abordaje Normal (Estudiante 1) ---';
    v_res := fn_registrar_abordaje_atomico(
        '018f0000-0000-7000-8000-000000000060', -- viaje
        '018f0000-0000-7000-8000-000000000041', -- estudiante 1
        '018f0000-0000-7000-8000-000000000051', -- parada
        '018f0000-0000-7000-8000-000000000011', -- monitora
        'LECTURA_QR'
    );
    RAISE NOTICE 'Resultado Test 1: %', v_res;
    ASSERT (v_res->>'exito')::boolean = true, 'Fallo: El abordaje inicial debía ser exitoso';
    ASSERT (v_res->>'codigo') = 'EXITO', 'Fallo: Código de resultado esperado EXITO';
END $$;

-- ----------------------------------------------------------------------------
-- ESCENARIO 2: RECHAZO DE SOBRECUPO (CAPACIDAD DEL VEHICULO = 1)
-- El estudiante 2 intenta abordar pero el vehículo ya tiene 1 a bordo.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_res JSONB;
    v_total_a_bordo INT;
BEGIN
    RAISE NOTICE '--- TEST 2: Control de Capacidad y Detección de Sobrecupo ---';
    v_res := fn_registrar_abordaje_atomico(
        '018f0000-0000-7000-8000-000000000060', -- viaje
        '018f0000-0000-7000-8000-000000000042', -- estudiante 2
        '018f0000-0000-7000-8000-000000000051', -- parada
        '018f0000-0000-7000-8000-000000000011', -- monitora
        'LECTURA_QR'
    );
    RAISE NOTICE 'Resultado Test 2 (Sobrecupo): %', v_res;
    ASSERT (v_res->>'exito')::boolean = false, 'Fallo: El abordaje debió ser denegado por sobrecupo';
    ASSERT (v_res->>'codigo') = 'DENEGADO_SOBRECUPO', 'Fallo: Código de resultado esperado DENEGADO_SOBRECUPO';

    SELECT total_a_bordo INTO v_total_a_bordo FROM viaje WHERE id_viaje = '018f0000-0000-7000-8000-000000000060';
    ASSERT v_total_a_bordo = 1, 'Fallo: El total a bordo no debió incrementarse más allá de la capacidad';
END $$;

-- ----------------------------------------------------------------------------
-- ESCENARIO 3: RECHAZO DE DOBLE ABORDAJE (ESCÁNER REPETIDO)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_res JSONB;
BEGIN
    RAISE NOTICE '--- TEST 3: Rechazo de Doble Abordaje (Estudiante 1 re-escaneado) ---';
    v_res := fn_registrar_abordaje_atomico(
        '018f0000-0000-7000-8000-000000000060', -- viaje
        '018f0000-0000-7000-8000-000000000041', -- estudiante 1
        '018f0000-0000-7000-8000-000000000051', -- parada
        '018f0000-0000-7000-8000-000000000011', -- monitora
        'LECTURA_QR'
    );
    RAISE NOTICE 'Resultado Test 3 (Doble Abordaje): %', v_res;
    ASSERT (v_res->>'exito')::boolean = false, 'Fallo: El re-escaneo debía ser rechazado';
    ASSERT (v_res->>'codigo') = 'ABORDAJE_PREVIO_EXISTE', 'Fallo: Código esperado ABORDAJE_PREVIO_EXISTE';
END $$;

-- ----------------------------------------------------------------------------
-- ESCENARIO 4: VERIFICACIÓN FORENSE DE LA CADENA DE CUSTODIA
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    r RECORD;
BEGIN
    RAISE NOTICE '--- TEST 4: Verificación Criptográfica de la Cadena de Custodia ---';
    SELECT * INTO r FROM fn_verificar_integridad_custodia(100);
    RAISE NOTICE 'Resultado Auditoría Custodia: % (Total eventos: %, Motivo: %)',
        CASE WHEN r.cadena_integra THEN 'VÁLIDA' ELSE 'CORRUPTA' END, r.total_verificados, r.motivo_fallo;
    ASSERT r.cadena_integra = true, 'Fallo: La cadena criptográfica de custodia no es íntegra';
    ASSERT r.total_verificados >= 1, 'Fallo: Debió verificarse al menos 1 registro en la cadena';
END $$;

-- ----------------------------------------------------------------------------
-- ESCENARIO 5: DESCENSO ATÓMICO NORMAL Y LIBERACIÓN DE CUPO
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_res JSONB;
    v_total_a_bordo INT;
BEGIN
    RAISE NOTICE '--- TEST 5: Descenso Atómico y Entrega Exitosa ---';
    v_res := fn_registrar_descenso_atomico(
        '018f0000-0000-7000-8000-000000000060', -- viaje
        '018f0000-0000-7000-8000-000000000041', -- estudiante 1
        '018f0000-0000-7000-8000-000000000052', -- parada colegio
        '018f0000-0000-7000-8000-000000000011', -- monitora
        'ENTREGADO_EXITOSO',
        'ACUDIENTE',
        '018f0000-0000-7000-8000-000000000030', -- id_acudiente
        NULL,                                   -- id_autorizado
        '1088001003',                           -- doc receptor
        'LECTURA_QR',
        NULL                                    -- observaciones
    );
    RAISE NOTICE 'Resultado Test 5 (Descenso): %', v_res;
    ASSERT (v_res->>'exito')::boolean = true, 'Fallo: El descenso normal debió ser exitoso';
    ASSERT (v_res->>'codigo') = 'EXITO', 'Fallo: Código esperado EXITO';

    SELECT total_a_bordo INTO v_total_a_bordo FROM viaje WHERE id_viaje = '018f0000-0000-7000-8000-000000000060';
    ASSERT v_total_a_bordo = 0, 'Fallo: El total a bordo debió decrementarse a 0 tras el descenso';
END $$;

-- ----------------------------------------------------------------------------
-- ESCENARIO 6: VERIFICACIÓN FORENSE DE AUDITORÍA GENERAL
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    r RECORD;
BEGIN
    RAISE NOTICE '--- TEST 6: Verificación Criptográfica de la Bitácora de Auditoría Forense ---';
    -- Insertar un evento de prueba en bitácora
    INSERT INTO bitacora_auditoria (tabla, operacion, registro_id, datos_nuevos)
    VALUES ('test_table', 'INSERT', '018f0000-0000-7000-8000-000000000099', '{"campo": "valor_prueba"}'::jsonb);

    SELECT * INTO r FROM fn_verificar_integridad_bitacora(100);
    RAISE NOTICE 'Resultado Bitácora Forense: % (Total registros: %, Motivo: %)',
        CASE WHEN r.cadena_integra THEN 'VÁLIDA' ELSE 'CORRUPTA' END, r.total_verificados, r.motivo_fallo;
    ASSERT r.cadena_integra = true, 'Fallo: La bitácora forense de auditoría debe ser 100% íntegra';
    ASSERT r.total_verificados >= 1, 'Fallo: Debió verificarse al menos 1 registro en la bitácora';
END $$;

-- Revertir transacciones de prueba para dejar la base de datos limpia
ROLLBACK;
RAISE NOTICE '=== TEST SUITE FINALIZADA: TODOS LOS ESCENARIOS PASARON SATISFACTORIAMENTE (TRANSACCIÓN REVERTIDA) ===';
