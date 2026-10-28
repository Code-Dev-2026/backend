-- ============================================================================
-- CAMINO SEGURO - TEST SUITE DE INTEGRIDAD Y REGLAS DE NEGOCIO (POSTGRESQL 16)
-- db/tests/test_suite_camino_seguro.sql
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_colegio_id UUID := '018f0000-0000-7000-8000-000000000001';
    v_empresa_id UUID := '018f0000-0000-7000-8000-000000000002';
    v_vehiculo_id UUID := '018f0000-0000-7000-8000-000000000003';
    v_user_cond_id UUID := '018f0000-0000-7000-8000-000000000010';
    v_user_mon_id UUID := '018f0000-0000-7000-8000-000000000011';
    v_user_acu_id UUID := '018f0000-0000-7000-8000-000000000012';
    v_conductor_id UUID := '018f0000-0000-7000-8000-000000000020';
    v_monitora_id UUID := '018f0000-0000-7000-8000-000000000021';
    v_acudiente_id UUID := '018f0000-0000-7000-8000-000000000030';
    v_estudiante_1 UUID := '018f0000-0000-7000-8000-000000000041';
    v_estudiante_2 UUID := '018f0000-0000-7000-8000-000000000042';
    v_ruta_id UUID := '018f0000-0000-7000-8000-000000000050';
    v_parada_subida UUID := '018f0000-0000-7000-8000-000000000051';
    v_parada_bajada UUID := '018f0000-0000-7000-8000-000000000052';
    v_viaje_id UUID := '018f0000-0000-7000-8000-000000000060';
    v_cifrado formato_cifrado_aes := 'v1:MTIzNDU2Nzg5MDEy:MTIzNDU2Nzg5MDEyMzQ1Ng==:Y2lwaGVydGV4dA==';
    v_res JSONB;
    v_total_a_bordo INT;
    r RECORD;
BEGIN
    RAISE NOTICE '=== 1. SETUP DE DATOS SEMILLA PARA PRUEBAS ===';

    -- Colegio
    INSERT INTO colegio (id_colegio, nombre, nit, direccion, telefono)
    VALUES (v_colegio_id, 'Colegio San Benito del Otún', '900123456-7', 'Km 4 Vía La Florida, Pereira', '+57 310 1234567')
    ON CONFLICT (id_colegio) DO NOTHING;

    -- Empresa Transportadora
    INSERT INTO empresa_transportadora (id_empresa, razon_social, nit, telefono, email_contacto)
    VALUES (v_empresa_id, 'Transportes Camino Seguro S.A.S.', '901987654-3', '+57 6 3209999', 'operaciones@caminoseguro.com')
    ON CONFLICT (id_empresa) DO NOTHING;

    -- Vehículo con capacidad nominal = 1 para test de sobrecupo
    INSERT INTO vehiculo (id_vehiculo, id_empresa, placa, capacidad_nominal, numero_movil, modelo, tarjeta_operacion, imei_gps_fijo)
    VALUES (v_vehiculo_id, v_empresa_id, 'WKK123', 1, 'BUS-01', 'Mercedes Sprinter', 'TO-998877', 'IMEI-8675309001')
    ON CONFLICT (id_vehiculo) DO NOTHING;

    -- Usuarios: Conductor, Monitora, Acudiente
    INSERT INTO usuario (id_usuario, email, password_hash)
    VALUES
        (v_user_cond_id, 'conductor@caminoseguro.edu.co', 'argon2id$mocked$hash'),
        (v_user_mon_id, 'monitora@caminoseguro.edu.co', 'argon2id$mocked$hash'),
        (v_user_acu_id, 'acudiente@padres.edu.co', 'argon2id$mocked$hash')
    ON CONFLICT (id_usuario) DO NOTHING;

    -- Conductor
    INSERT INTO conductor (id_conductor, id_usuario, id_empresa, nombres, apellidos, numero_licencia, vigencia_licencia, telefono)
    VALUES (v_conductor_id, v_user_cond_id, v_empresa_id, 'Carlos', 'Conductor', 'LIC-108801', CURRENT_DATE + INTERVAL '365 days', '+573001111111')
    ON CONFLICT (id_conductor) DO NOTHING;

    -- Monitora
    INSERT INTO monitora (id_monitora, id_usuario, id_empresa, nombres, apellidos, documento_cifrado, documento_blind_index, telefono)
    VALUES (v_monitora_id, v_user_mon_id, v_empresa_id, 'Marta', 'Monitora', v_cifrado, encode(digest('DOC-MON-01', 'sha256'), 'hex'), '+573002222222')
    ON CONFLICT (id_monitora) DO NOTHING;

    -- Acudiente
    INSERT INTO acudiente (id_acudiente, id_usuario, nombres, apellidos, documento_cifrado, documento_blind_index, telefono_principal_cifrado, telefono_emergencia_cifrado, direccion_cifrada)
    VALUES (v_acudiente_id, v_user_acu_id, 'Ana', 'Gomez', v_cifrado, encode(digest('DOC-ACU-01', 'sha256'), 'hex'), v_cifrado, v_cifrado, v_cifrado)
    ON CONFLICT (id_acudiente) DO NOTHING;

    -- Estudiantes 1 y 2
    INSERT INTO estudiante (id_estudiante, id_colegio, codigo_institucional, documento_cifrado, documento_blind_index, nombres_cifrado, apellidos_cifrado, fecha_nacimiento_cifrada, grado, qr_token_hash, domicilio_punto)
    VALUES
        (v_estudiante_1, v_colegio_id, 'EST-001', v_cifrado, encode(digest('DOC-EST-01', 'sha256'), 'hex'), v_cifrado, v_cifrado, v_cifrado, '5A', encode(digest('QR-EST-01', 'sha256'), 'hex'), ST_SetSRID(ST_MakePoint(-75.690, 4.810), 4326)::geography),
        (v_estudiante_2, v_colegio_id, 'EST-002', v_cifrado, encode(digest('DOC-EST-02', 'sha256'), 'hex'), v_cifrado, v_cifrado, v_cifrado, '5B', encode(digest('QR-EST-02', 'sha256'), 'hex'), ST_SetSRID(ST_MakePoint(-75.691, 4.811), 4326)::geography)
    ON CONFLICT (id_estudiante) DO NOTHING;

    -- Vínculos Estudiante - Acudiente
    INSERT INTO estudiante_acudiente (id_estudiante, id_acudiente, parentesco, es_tutor_principal, orden_notificacion)
    VALUES
        (v_estudiante_1, v_acudiente_id, 'MADRE', true, 1),
        (v_estudiante_2, v_acudiente_id, 'MADRE', true, 1)
    ON CONFLICT (id_estudiante, id_acudiente) DO NOTHING;

    -- Ruta
    INSERT INTO ruta (id_ruta, id_colegio, id_empresa, codigo, nombre, jornada, polilinea_oficial, origen_nombre, destino_nombre)
    VALUES (
        v_ruta_id, v_colegio_id, v_empresa_id, 'R-01', 'Ruta Pinares - San Benito', 'MANANA',
        ST_SetSRID(ST_MakeLine(ST_MakePoint(-75.690, 4.810), ST_MakePoint(-75.696, 4.813)), 4326)::geography,
        'Pinares', 'Colegio San Benito'
    ) ON CONFLICT (id_ruta) DO NOTHING;

    -- Paradas (subida y bajada)
    INSERT INTO parada (id_parada, id_ruta, nombre, orden_secuencia, punto_geografico, horario_estimado, radio_geocerca)
    VALUES
        (v_parada_subida, v_ruta_id, 'Parada Pinares', 1, ST_SetSRID(ST_MakePoint(-75.690, 4.810), 4326)::geography, '06:30:00'::time, ST_SetSRID(ST_Buffer(ST_MakePoint(-75.690, 4.810)::geography, 100)::geometry, 4326)::geography),
        (v_parada_bajada, v_ruta_id, 'Colegio Entrada', 2, ST_SetSRID(ST_MakePoint(-75.696, 4.813), 4326)::geography, '07:00:00'::time, ST_SetSRID(ST_Buffer(ST_MakePoint(-75.696, 4.813)::geography, 100)::geometry, 4326)::geography)
    ON CONFLICT (id_ruta, orden_secuencia) DO NOTHING;

    -- Asignación de ambos estudiantes
    INSERT INTO asignacion_ruta (id_estudiante, id_ruta, id_parada_subida, id_parada_bajada, ciclo_horario)
    VALUES
        (v_estudiante_1, v_ruta_id, v_parada_subida, v_parada_bajada, 'IDA'),
        (v_estudiante_2, v_ruta_id, v_parada_subida, v_parada_bajada, 'IDA')
    ON CONFLICT DO NOTHING;

    -- Viaje en estado EN_CURSO
    INSERT INTO viaje (id_viaje, id_ruta, id_vehiculo, id_conductor, id_monitora, fecha, hora_inicio_programada, hora_fin_programada, estado, hora_inicio_real, total_a_bordo)
    VALUES (
        v_viaje_id, v_ruta_id, v_vehiculo_id, v_conductor_id, v_monitora_id,
        CURRENT_DATE, NOW() - INTERVAL '10 minutes', NOW() + INTERVAL '50 minutes',
        'EN_CURSO', NOW() - INTERVAL '10 minutes', 0
    ) ON CONFLICT (id_viaje) DO NOTHING;

    -- viaje_estudiante en estado EN_CASA_ESPERA
    INSERT INTO viaje_estudiante (id_viaje, id_estudiante, estado_custodia)
    VALUES
        (v_viaje_id, v_estudiante_1, 'EN_CASA_ESPERA'),
        (v_viaje_id, v_estudiante_2, 'EN_CASA_ESPERA')
    ON CONFLICT (id_viaje, id_estudiante) DO NOTHING;

    RAISE NOTICE '=== 2. TEST: ABORDAJE EXITOSO ESTUDIANTE 1 ===';
    v_res := fn_registrar_abordaje_atomico(
        v_viaje_id,
        v_estudiante_1,
        'QR_INSTITUCIONAL',
        ST_SetSRID(ST_MakePoint(-75.690, 4.810), 4326)::geography,
        v_user_mon_id
    );
    RAISE NOTICE 'Resultado Test 1: %', v_res;
    ASSERT (v_res->>'exito')::boolean = true, 'Fallo: El abordaje inicial debió ser exitoso';
    ASSERT (v_res->>'codigo') = 'EXITO_ABORDAJE', 'Fallo: Código de abordaje no coincide';

    RAISE NOTICE '=== 3. TEST: SOBRECUPO BLOQUEADO (CAPACIDAD = 1) ===';
    v_res := fn_registrar_abordaje_atomico(
        v_viaje_id,
        v_estudiante_2,
        'QR_INSTITUCIONAL',
        ST_SetSRID(ST_MakePoint(-75.690, 4.810), 4326)::geography,
        v_user_mon_id
    );
    RAISE NOTICE 'Resultado Test 2 (Sobrecupo): %', v_res;
    ASSERT (v_res->>'exito')::boolean = false, 'Fallo: El abordaje con capacidad nominal agotada debió ser rechazado';
    ASSERT (v_res->>'codigo') = 'DENEGADO_SOBRECUPO', 'Fallo: Código esperado DENEGADO_SOBRECUPO';

    SELECT total_a_bordo INTO v_total_a_bordo FROM viaje WHERE id_viaje = v_viaje_id;
    ASSERT v_total_a_bordo = 1, 'Fallo: total_a_bordo no debe superar la capacidad de 1';

    RAISE NOTICE '=== 4. TEST: VERIFICACIÓN FORENSE CADENA DE CUSTODIA ===';
    SELECT * INTO r FROM fn_verificar_integridad_custodia(100);
    RAISE NOTICE 'Resultado Custodia: secuencia=% es_valido=%', r.p_secuencia, r.es_valido;
    ASSERT r.es_valido = true, 'Fallo: La cadena criptográfica de custodia no es íntegra';

    RAISE NOTICE '=== 5. TEST: DESCENSO ATÓMICO Y ENTREGA EXITOSA ===';
    v_res := fn_registrar_descenso_atomico(
        v_viaje_id,
        v_estudiante_1,
        'ACUDIENTE',
        v_acudiente_id,
        NULL,
        'ENTREGADO_EXITOSO',
        'https://caminoseguro.edu.co/evidencias/foto1.jpg',
        ST_SetSRID(ST_MakePoint(-75.696, 4.813), 4326)::geography,
        'Entrega normal sin novedades',
        v_user_mon_id
    );
    RAISE NOTICE 'Resultado Test 3 (Descenso): %', v_res;
    ASSERT (v_res->>'exito')::boolean = true, 'Fallo: El descenso debió ser exitoso';

    SELECT total_a_bordo INTO v_total_a_bordo FROM viaje WHERE id_viaje = v_viaje_id;
    ASSERT v_total_a_bordo = 0, 'Fallo: total_a_bordo debió decrementarse a 0 tras el descenso';

    RAISE NOTICE '=== 6. TEST: VERIFICACIÓN FORENSE BITÁCORA GENERAL ===';
    INSERT INTO bitacora_auditoria (tabla, operacion, registro_id, datos_nuevos)
    VALUES ('colegio', 'INSERT', v_colegio_id, '{"nombre": "San Benito"}'::jsonb);

    SELECT * INTO r FROM fn_verificar_integridad_bitacora(100);
    RAISE NOTICE 'Resultado Bitácora Forense: cadena_integra=% total=%', r.cadena_integra, r.total_verificados;
    ASSERT r.cadena_integra = true, 'Fallo: La bitácora forense de auditoría debe ser 100% íntegra';

    RAISE NOTICE '=== TODOS LOS TESTS EJECUTADOS SATISFACTORIAMENTE ===';
END $$;

ROLLBACK;
