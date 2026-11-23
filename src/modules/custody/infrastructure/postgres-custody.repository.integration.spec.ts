import * as crypto from "crypto";
import { Pool } from "pg";
import { TripStateEnum } from "@common/enums/trip-state.enum";
import {
  CustodyInvariantViolationError,
  FsmCustodyState,
  TripClosureBlockedError,
  TripDirection,
} from "../domain/custody.types";
import { PostgresCustodyRepository } from "./postgres-custody.repository";

const runPostgres =
  process.env.RUN_POSTGRES_TESTS === "true" ||
  process.env.RUN_POSTGIS_TESTS === "true";
const describeIfPostgres = runPostgres ? describe : describe.skip;

/**
 * Pruebas de integración contra PostgreSQL 16 + PostGIS 3.4 real (Issue #7).
 * Se ejecutan activando RUN_POSTGRES_TESTS=true (o RUN_POSTGIS_TESTS=true)
 * contra el contenedor local después de aplicar V001..V014.
 *
 * Verifica (DoD Issue #7):
 * 1. Criterio de aceptación: fn_registrar_transicion_custodia rechaza
 *    NO_INICIADO -> ENTREGADO_ACUDIENTE sin mutar viaje_estudiante ni historial_estado_custodia.
 * 2. Encadenamiento SHA-256 en historial_estado_custodia (trg_encadenar_hash_custodia)
 *    verificado con fn_verificar_integridad_custodia().
 * 3. Inmutabilidad WORM en PostgreSQL: UPDATE, DELETE y TRUNCATE sobre
 *    historial_estado_custodia bloqueados con SQLSTATE 55000 (trg_custodia_inmutable_*).
 * 4. Bloqueo de cierre de viaje (FINALIZADO) con menores A_BORDO_VEHICULO
 *    mediante trg_bloquear_cierre_viaje_con_menores_a_bordo.
 * 5. Inicialización matutina idempotente mediante fn_inicializar_custodia_matutina(fecha).
 */
describeIfPostgres(
  "PostgresCustodyRepository (Integración PostgreSQL 16 WORM + FSM V014)",
  () => {
    let pool: Pool;
    let repository: PostgresCustodyRepository;
    const tag = crypto.randomBytes(4).toString("hex");
    const todayIso = new Date().toISOString().slice(0, 10);

    let idColegio: string;
    let idEmpresa: string;
    let idVehiculo: string;
    let idConductorUsuario: string;
    let idConductor: string;
    let idMonitoraUsuario: string;
    let idMonitora: string;
    let idRuta: string;
    let idParada: string;
    let idEstudiante: string;
    let idViaje: string;

    beforeAll(async () => {
      pool = new Pool({
        host: process.env.DB_HOST ?? "localhost",
        port: Number(process.env.DB_PORT ?? "5432"),
        database: process.env.DB_NAME ?? "camino_seguro_db",
        user: process.env.DB_USER ?? "app_user",
        password: process.env.DB_PASSWORD ?? "",
      });
      repository = new PostgresCustodyRepository(pool, false);

      const col = await pool.query<{ id_colegio: string }>(
        `INSERT INTO public.colegio (nombre, nit, direccion, telefono)
         VALUES ($1, $2, 'Carrera 7 No. 24-50, Pereira', '3134567')
         RETURNING id_colegio`,
        [`Colegio Test FSM ${tag}`, `902${tag}-1`],
      );
      idColegio = col.rows[0].id_colegio;

      const emp = await pool.query<{ id_empresa: string }>(
        `INSERT INTO public.empresa_transportadora (razon_social, nit, telefono, email_contacto)
         VALUES ($1, $2, '3245678', $3)
         RETURNING id_empresa`,
        [`Transportes FSM ${tag}`, `903${tag}-2`, `fsm-${tag}@test.co`],
      );
      idEmpresa = emp.rows[0].id_empresa;

      const veh = await pool.query<{ id_vehiculo: string }>(
        `INSERT INTO public.vehiculo (
           id_empresa, placa, capacidad_nominal, numero_movil,
           modelo, tarjeta_operacion, imei_gps_fijo
         )
         VALUES ($1, $2, 15, $3, '2025', $4, $5)
         RETURNING id_vehiculo`,
        [
          idEmpresa,
          `FS${tag.slice(0, 4).toUpperCase()}`,
          `M-${tag.slice(0, 4)}`,
          `TO-${tag}`,
          `IMEI-${tag}`,
        ],
      );
      idVehiculo = veh.rows[0].id_vehiculo;

      const aesDummy = `v1:${"a".repeat(24)}:${"b".repeat(32)}:${"c".repeat(16)}`;
      const hashMon = crypto
        .createHash("sha256")
        .update(`mon-fsm-${tag}`)
        .digest("hex");

      const uCond = await pool.query<{ id_usuario: string }>(
        `INSERT INTO public.usuario (email, password_hash)
         VALUES ($1, 'hash_test')
         RETURNING id_usuario`,
        [`cond-${tag}@test.co`],
      );
      idConductorUsuario = uCond.rows[0].id_usuario;

      const cond = await pool.query<{ id_conductor: string }>(
        `INSERT INTO public.conductor (
           id_usuario, id_empresa, nombres, apellidos, numero_licencia, vigencia_licencia, telefono
         )
         VALUES ($1, $2, 'Carlos', 'Conductor', $3, CURRENT_DATE + INTERVAL '1 year', '3001111111')
         RETURNING id_conductor`,
        [idConductorUsuario, idEmpresa, `LIC-${tag}`],
      );
      idConductor = cond.rows[0].id_conductor;

      const uMon = await pool.query<{ id_usuario: string }>(
        `INSERT INTO public.usuario (email, password_hash)
         VALUES ($1, 'hash_test')
         RETURNING id_usuario`,
        [`mon-${tag}@test.co`],
      );
      idMonitoraUsuario = uMon.rows[0].id_usuario;

      const mon = await pool.query<{ id_monitora: string }>(
        `INSERT INTO public.monitora (
           id_usuario, id_empresa, nombres, apellidos, documento_cifrado, documento_blind_index, telefono
         )
         VALUES ($1, $2, 'Ana', 'Monitora', $3, $4, '3002222222')
         RETURNING id_monitora`,
        [idMonitoraUsuario, idEmpresa, aesDummy, hashMon],
      );
      idMonitora = mon.rows[0].id_monitora;

      const ruta = await pool.query<{ id_ruta: string }>(
        `INSERT INTO public.ruta (
           id_colegio, id_empresa, codigo, nombre, jornada,
           polilinea_oficial, origen_nombre, destino_nombre
         )
         VALUES (
           $1, $2, $3, 'Ruta Test FSM', 'MANANA',
           ST_GeogFromText('SRID=4326;LINESTRING(-75.6961 4.8133, -75.6946 4.8143)'),
           'Los Alamos', 'San Benito'
         )
         RETURNING id_ruta`,
        [idColegio, idEmpresa, `RFSM-${tag}`],
      );
      idRuta = ruta.rows[0].id_ruta;

      const parada = await pool.query<{ id_parada: string }>(
        `INSERT INTO public.parada (
           id_ruta, nombre, orden_secuencia, punto_geografico,
           horario_estimado, radio_geocerca
         )
         VALUES (
           $1, 'Parada 1 FSM', 1,
           ST_GeogFromText('SRID=4326;POINT(-75.6961 4.8133)'),
           '06:20:00',
           ST_GeogFromText('SRID=4326;POLYGON((-75.697 4.812, -75.695 4.812, -75.695 4.814, -75.697 4.814, -75.697 4.812))')
         )
         RETURNING id_parada`,
        [idRuta],
      );
      idParada = parada.rows[0].id_parada;

      const hash1 = crypto
        .createHash("sha256")
        .update(`doc-fsm-${tag}`)
        .digest("hex");
      const hash2 = crypto
        .createHash("sha256")
        .update(`qr-fsm-${tag}`)
        .digest("hex");

      const est = await pool.query<{ id_estudiante: string }>(
        `INSERT INTO public.estudiante (
           id_colegio, codigo_institucional, documento_cifrado,
           documento_blind_index, nombres_cifrado, apellidos_cifrado,
           fecha_nacimiento_cifrada, grado, qr_token_hash, domicilio_punto
         )
         VALUES (
           $1, $2, $3, $4, $3, $3, $3, '6A', $5,
           ST_SetSRID(ST_MakePoint(-75.6961, 4.8133), 4326)::geography
         )
         RETURNING id_estudiante`,
        [idColegio, `EST-FSM-${tag}`, aesDummy, hash1, hash2],
      );
      idEstudiante = est.rows[0].id_estudiante;

      await pool.query(
        `INSERT INTO public.asignacion_ruta (
           id_estudiante, id_ruta, id_parada_subida, id_parada_bajada, ciclo_horario, activa
         )
         VALUES ($1, $2, $3, $3, 'AMBOS', TRUE)`,
        [idEstudiante, idRuta, idParada],
      );

      const viaje = await pool.query<{ id_viaje: string }>(
        `INSERT INTO public.viaje (
           id_ruta, id_vehiculo, id_conductor, id_monitora, fecha,
           hora_inicio_programada, hora_fin_programada, estado
         )
         VALUES (
           $1, $2, $3, $4, $5::date,
           NOW() + INTERVAL '1 hour', NOW() + INTERVAL '2 hours', 'EN_CURSO'
         )
         RETURNING id_viaje`,
        [idRuta, idVehiculo, idConductor, idMonitora, todayIso],
      );
      idViaje = viaje.rows[0].id_viaje;
    });

    afterAll(async () => {
      await pool.end();
    });

    it("inicializa custodia matutina idempotente con fn_inicializar_custodia_matutina en NO_INICIADO", async () => {
      const firstRun = await repository.initializeMorningCustody(todayIso);
      expect(
        firstRun.registros.some(
          (r) => r.id_viaje === idViaje && r.id_estudiante === idEstudiante,
        ),
      ).toBe(true);

      const state = await repository.getStudentTripState(idViaje, idEstudiante);
      expect(state?.estado_custodia).toBe(FsmCustodyState.NO_INICIADO);

      const secondRun = await repository.initializeMorningCustody(todayIso);
      expect(
        secondRun.registros.some(
          (r) => r.id_viaje === idViaje && r.id_estudiante === idEstudiante,
        ),
      ).toBe(false);
    });

    it("Criterio de Aceptación #7 en PostgreSQL: fn_registrar_transicion_custodia rechaza NO_INICIADO -> ENTREGADO_ACUDIENTE sin alterar tablas", async () => {
      await expect(
        repository.applyTransitionAndAppendHistory({
          id_viaje: idViaje,
          id_estudiante: idEstudiante,
          estado_destino: FsmCustodyState.ENTREGADO_ACUDIENTE,
          tipo_recorrido: TripDirection.TARDE,
          disparador_evento: "SALTO_ILEGAL",
          registrado_por_usuario: idMonitoraUsuario,
        }),
      ).rejects.toThrow(CustodyInvariantViolationError);

      const state = await repository.getStudentTripState(idViaje, idEstudiante);
      expect(state?.estado_custodia).toBe(FsmCustodyState.NO_INICIADO);

      const history = await repository.listHistoryByTrip(idViaje);
      expect(history).toHaveLength(0);
    });

    it("encadena SHA-256 en historial_estado_custodia, bloquea cierre con A_BORDO_VEHICULO y valida triggers WORM (UPDATE/DELETE/TRUNCATE)", async () => {
      const t1 = await repository.applyTransitionAndAppendHistory({
        id_viaje: idViaje,
        id_estudiante: idEstudiante,
        estado_destino: FsmCustodyState.EN_ESPERA_ABORDAJE,
        tipo_recorrido: TripDirection.MANANA,
        disparador_evento: "ESPERA_PARADA",
        registrado_por_usuario: idMonitoraUsuario,
        coordenadas: { latitud: 4.8133, longitud: -75.6961 },
      });
      expect(t1.history.hash_sha256_actual).toMatch(/^[a-f0-9]{64}$/);

      const t2 = await repository.applyTransitionAndAppendHistory({
        id_viaje: idViaje,
        id_estudiante: idEstudiante,
        estado_destino: FsmCustodyState.A_BORDO_VEHICULO,
        tipo_recorrido: TripDirection.MANANA,
        disparador_evento: "ABORDAJE_QR",
        registrado_por_usuario: idMonitoraUsuario,
      });
      expect(t2.history.hash_sha256_anterior).toBe(
        t1.history.hash_sha256_actual,
      );

      // Bloqueo SQL de cierre mientras el menor sigue A_BORDO_VEHICULO
      await expect(repository.finalizeTrip(idViaje)).rejects.toThrow(
        TripClosureBlockedError,
      );

      // Desembarque válido en colegio y cierre del viaje
      const t3 = await repository.applyTransitionAndAppendHistory({
        id_viaje: idViaje,
        id_estudiante: idEstudiante,
        estado_destino: FsmCustodyState.EN_COLEGIO,
        tipo_recorrido: TripDirection.MANANA,
        disparador_evento: "LLEGADA_SEDE",
        registrado_por_usuario: idMonitoraUsuario,
        coordenadas: { latitud: 4.8143, longitud: -75.6946 },
      });
      expect(t3.history.hash_sha256_anterior).toBe(
        t2.history.hash_sha256_actual,
      );

      const finalized = await repository.finalizeTrip(idViaje);
      expect(finalized.estado).toBe(TripStateEnum.FINALIZADO);

      // Verificación forense completa en PostgreSQL
      const integrity = await repository.verifyHistoryIntegrity(10000);
      expect(integrity.cadena_integra).toBe(true);
      expect(integrity.total_verificados).toBeGreaterThanOrEqual(3);

      // Validación estricta de triggers WORM (V008) en PostgreSQL
      await expect(
        pool.query(
          `UPDATE public.historial_estado_custodia
           SET disparador_evento = 'MANIPULADO'
           WHERE id_historial = $1`,
          [t1.history.id_historial],
        ),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(55000|42501)$/) });

      await expect(
        pool.query(
          `DELETE FROM public.historial_estado_custodia WHERE id_historial = $1`,
          [t1.history.id_historial],
        ),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(55000|42501)$/) });

      await expect(
        pool.query(`TRUNCATE TABLE public.historial_estado_custodia`),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(55000|42501)$/) });

      // Confirmar que los triggers de inmutabilidad WORM, encadenamiento y cierre están activos en pg_trigger
      const triggers = await pool.query<{ tgname: string }>(
        `SELECT tgname
         FROM pg_trigger
         WHERE NOT tgisinternal
           AND tgenabled <> 'D'
           AND tgname IN (
             'trg_encadenar_hash_custodia',
             'trg_custodia_inmutable_upd_del',
             'trg_custodia_inmutable_truncate',
             'trg_bloquear_cierre_viaje_con_menores_a_bordo'
           )
         ORDER BY tgname ASC`,
      );
      expect(triggers.rows.map((r) => r.tgname)).toEqual([
        "trg_bloquear_cierre_viaje_con_menores_a_bordo",
        "trg_custodia_inmutable_truncate",
        "trg_custodia_inmutable_upd_del",
        "trg_encadenar_hash_custodia",
      ]);
    });
  },
);
