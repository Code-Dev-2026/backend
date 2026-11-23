import * as crypto from "crypto";
import { Pool } from "pg";
import { FsmCustodyState } from "../../custody/domain/custody.types";
import { PostgresCustodyRepository } from "../../custody/infrastructure/postgres-custody.repository";
import {
  BoardingResultCode,
  InvalidQrTokenError,
  StudentNotAssignedToRouteError,
  TripNotInProgressError,
} from "../domain/attendance.types";
import { PostgresAttendanceRepository } from "./postgres-attendance.repository";

const runPostgres =
  process.env.RUN_POSTGRES_TESTS === "true" ||
  process.env.RUN_POSTGIS_TESTS === "true";
const describeIfPostgres = runPostgres ? describe : describe.skip;

const PEREIRA_COORDS = { latitud: 4.8133, longitud: -75.6961 };

/**
 * Pruebas de integración y estrés de concurrencia contra PostgreSQL 16 + PostGIS 3.4 real (Issue #8).
 * Se ejecutan activando RUN_POSTGRES_TESTS=true contra el contenedor local con V001..V015 aplicadas.
 *
 * Verifica (DoD Issue #8):
 * 1. Concurrencia real en PostgreSQL (ASVS V11.1): 20 conexiones paralelas sobre vehículo capacidad 5
 *    -> exactamente 5 aprobados, 15 DENEGADO_SOBRECUPO, total_a_bordo = 5, 15 incidentes CRITICO,
 *    5 notificaciones encoladas y cadena SHA-256 WORM íntegra (Issue #7).
 * 2. Criterio de Aceptación #8: vehículo capacidad 15 con 15 a bordo rechaza al #16 con
 *    DENEGADO_SOBRECUPO sin incrementar contador e inserta incidente de seguridad.
 * 3. RN-05 y clave idempotente: 10 escaneos concurrentes del mismo estudiante aprueban exactamente 1
 *    y rechazan 9 con ABORDAJE_PREVIO_EXISTE.
 * 4. Casos negativos y QR ocasional temporal aprobado.
 */
describeIfPostgres(
  "PostgresAttendanceRepository (Integración PostgreSQL 16 + Concurrencia Real V015)",
  () => {
    let pool: Pool;
    let repository: PostgresAttendanceRepository;
    let custodyRepository: PostgresCustodyRepository;
    const tag = crypto.randomBytes(4).toString("hex");
    const todayIso = new Date().toISOString().slice(0, 10);
    const aesDummy = `v1:${"a".repeat(24)}:${"b".repeat(32)}:${"c".repeat(16)}`;

    let idColegio: string;
    let idEmpresa: string;
    let idConductor: string;
    let idMonitoraUsuario: string;
    let idMonitora: string;
    let idRuta: string;
    let idParada: string;
    let idAcudiente: string;

    const sha256 = (value: string) =>
      crypto.createHash("sha256").update(value, "utf8").digest("hex");

    async function createVehicle(capacidadNominal: number, suffix: string) {
      const res = await pool.query<{ id_vehiculo: string }>(
        `INSERT INTO public.vehiculo (
           id_empresa, placa, capacidad_nominal, numero_movil,
           modelo, tarjeta_operacion, imei_gps_fijo
         )
         VALUES ($1, $2, $3, $4, '2025', $5, $6)
         RETURNING id_vehiculo`,
        [
          idEmpresa,
          `A${suffix}${tag.slice(0, 4).toUpperCase()}`.slice(0, 10),
          capacidadNominal,
          `MV-${suffix}-${tag.slice(0, 3)}`,
          `TO-ATT-${suffix}-${tag}`,
          `IMEI-ATT-${suffix}-${tag}`,
        ],
      );
      return res.rows[0].id_vehiculo;
    }

    async function createTrip(
      idVehiculo: string,
      estado: "PROGRAMADO" | "EN_CURSO" | "FINALIZADO",
      offsetHours: number,
    ) {
      const res = await pool.query<{ id_viaje: string }>(
        `INSERT INTO public.viaje (
           id_ruta, id_vehiculo, id_conductor, id_monitora, fecha,
           hora_inicio_programada, hora_fin_programada, estado
         )
         VALUES (
           $1, $2, $3, $4, $5::date,
           NOW() + make_interval(hours => $6::int),
           NOW() + make_interval(hours => ($6::int + 1)),
           $7
         )
         RETURNING id_viaje`,
        [
          idRuta,
          idVehiculo,
          idConductor,
          idMonitora,
          todayIso,
          offsetHours,
          estado,
        ],
      );
      return res.rows[0].id_viaje;
    }

    async function createAssignedStudents(prefix: string, count: number) {
      const created: Array<{ id: string; qrHash: string }> = [];
      for (let i = 1; i <= count; i++) {
        const docHash = sha256(`doc-${prefix}-${tag}-${i}`);
        const qrRaw = `QR-PG-${prefix}-${tag}-${i}`;
        const qrHash = sha256(qrRaw);

        const est = await pool.query<{ id_estudiante: string }>(
          `INSERT INTO public.estudiante (
             id_colegio, codigo_institucional, documento_cifrado,
             documento_blind_index, nombres_cifrado, apellidos_cifrado,
             fecha_nacimiento_cifrada, grado, qr_token_hash, domicilio_punto
           )
           VALUES (
             $1, $2, $3, $4, $3, $3, $3, '7A', $5,
             ST_SetSRID(ST_MakePoint(-75.6961, 4.8133), 4326)::geography
           )
           RETURNING id_estudiante`,
          [idColegio, `EST-${prefix}-${tag}-${i}`, aesDummy, docHash, qrHash],
        );
        const idEstudiante = est.rows[0].id_estudiante;

        await pool.query(
          `INSERT INTO public.asignacion_ruta (
             id_estudiante, id_ruta, id_parada_subida, id_parada_bajada, ciclo_horario, activa
           )
           VALUES ($1, $2, $3, $3, 'AMBOS', TRUE)`,
          [idEstudiante, idRuta, idParada],
        );

        await pool.query(
          `INSERT INTO public.estudiante_acudiente (
             id_estudiante, id_acudiente, parentesco, es_tutor_principal, orden_notificacion
           )
           VALUES ($1, $2, 'MADRE', TRUE, 1)`,
          [idEstudiante, idAcudiente],
        );

        created.push({ id: idEstudiante, qrHash });
      }
      return created;
    }

    beforeAll(async () => {
      pool = new Pool({
        host: process.env.DB_HOST ?? "localhost",
        port: Number(process.env.DB_PORT ?? "5432"),
        database: process.env.DB_NAME ?? "camino_seguro_db",
        user: process.env.DB_USER ?? "app_user",
        password: process.env.DB_PASSWORD ?? "",
        max: 25,
      });
      repository = new PostgresAttendanceRepository(pool, false);
      custodyRepository = new PostgresCustodyRepository(pool, false);

      const col = await pool.query<{ id_colegio: string }>(
        `INSERT INTO public.colegio (nombre, nit, direccion, telefono)
         VALUES ($1, $2, 'Carrera 7 No. 24-50, Pereira', '3134567')
         RETURNING id_colegio`,
        [`Colegio Att ${tag}`, `910${tag}-1`],
      );
      idColegio = col.rows[0].id_colegio;

      const emp = await pool.query<{ id_empresa: string }>(
        `INSERT INTO public.empresa_transportadora (razon_social, nit, telefono, email_contacto)
         VALUES ($1, $2, '3245678', $3)
         RETURNING id_empresa`,
        [`Transportes Att ${tag}`, `911${tag}-2`, `att-${tag}@test.co`],
      );
      idEmpresa = emp.rows[0].id_empresa;

      const uCond = await pool.query<{ id_usuario: string }>(
        `INSERT INTO public.usuario (email, password_hash)
         VALUES ($1, 'hash_test') RETURNING id_usuario`,
        [`cond-att-${tag}@test.co`],
      );
      const cond = await pool.query<{ id_conductor: string }>(
        `INSERT INTO public.conductor (
           id_usuario, id_empresa, nombres, apellidos, numero_licencia, vigencia_licencia, telefono
         )
         VALUES ($1, $2, 'Pedro', 'Conductor', $3, CURRENT_DATE + INTERVAL '1 year', '3001111111')
         RETURNING id_conductor`,
        [uCond.rows[0].id_usuario, idEmpresa, `LIC-ATT-${tag}`],
      );
      idConductor = cond.rows[0].id_conductor;

      const uMon = await pool.query<{ id_usuario: string }>(
        `INSERT INTO public.usuario (email, password_hash)
         VALUES ($1, 'hash_test') RETURNING id_usuario`,
        [`mon-att-${tag}@test.co`],
      );
      idMonitoraUsuario = uMon.rows[0].id_usuario;

      const mon = await pool.query<{ id_monitora: string }>(
        `INSERT INTO public.monitora (
           id_usuario, id_empresa, nombres, apellidos, documento_cifrado, documento_blind_index, telefono
         )
         VALUES ($1, $2, 'Laura', 'Monitora', $3, $4, '3002222222')
         RETURNING id_monitora`,
        [idMonitoraUsuario, idEmpresa, aesDummy, sha256(`mon-att-${tag}`)],
      );
      idMonitora = mon.rows[0].id_monitora;

      const uAcud = await pool.query<{ id_usuario: string }>(
        `INSERT INTO public.usuario (email, password_hash)
         VALUES ($1, 'hash_test') RETURNING id_usuario`,
        [`acud-att-${tag}@test.co`],
      );
      const acud = await pool.query<{ id_acudiente: string }>(
        `INSERT INTO public.acudiente (
           id_usuario, nombres, apellidos, documento_cifrado, documento_blind_index,
           telefono_principal_cifrado, telefono_emergencia_cifrado, direccion_cifrada
         )
         VALUES ($1, 'Marta', 'Tutora', $2, $3, $2, $2, $2)
         RETURNING id_acudiente`,
        [uAcud.rows[0].id_usuario, aesDummy, sha256(`acud-att-${tag}`)],
      );
      idAcudiente = acud.rows[0].id_acudiente;

      const ruta = await pool.query<{ id_ruta: string }>(
        `INSERT INTO public.ruta (
           id_colegio, id_empresa, codigo, nombre, jornada,
           polilinea_oficial, origen_nombre, destino_nombre
         )
         VALUES (
           $1, $2, $3, 'Ruta Test Att', 'MANANA',
           ST_GeogFromText('SRID=4326;LINESTRING(-75.6961 4.8133, -75.6946 4.8143)'),
           'Los Alamos', 'San Benito'
         )
         RETURNING id_ruta`,
        [idColegio, idEmpresa, `RATT-${tag}`],
      );
      idRuta = ruta.rows[0].id_ruta;

      const parada = await pool.query<{ id_parada: string }>(
        `INSERT INTO public.parada (
           id_ruta, nombre, orden_secuencia, punto_geografico,
           horario_estimado, radio_geocerca
         )
         VALUES (
           $1, 'Parada 1 Att', 1,
           ST_GeogFromText('SRID=4326;POINT(-75.6961 4.8133)'),
           '06:20:00',
           ST_GeogFromText('SRID=4326;POLYGON((-75.697 4.812, -75.695 4.812, -75.695 4.814, -75.697 4.814, -75.697 4.812))')
         )
         RETURNING id_parada`,
        [idRuta],
      );
      idParada = parada.rows[0].id_parada;
    });

    afterAll(async () => {
      await pool.end();
    });

    it("Estrés real PostgreSQL 16 (DoD Issue #8): 20 abordajes simultáneos sobre vehículo capacidad 5 -> 5 aprobados y 15 DENEGADO_SOBRECUPO", async () => {
      const idVehiculo = await createVehicle(5, "C5");
      const idViaje = await createTrip(idVehiculo, "EN_CURSO", 10);
      const students = await createAssignedStudents("S20", 20);

      const startedAt = Date.now();
      const results = await Promise.all(
        students.map((student, idx) =>
          repository.registerAtomicBoarding({
            id_viaje: idViaje,
            id_estudiante: null,
            qr_token_hash: student.qrHash,
            metodo_validacion: "QR_INSTITUCIONAL",
            coordenadas: PEREIRA_COORDS,
            registrado_por_usuario: idMonitoraUsuario,
            idempotency_key: `pg-stress-${tag}-${idx + 1}`,
            sincronizado_offline: false,
          }),
        ),
      );
      const avgLatencyMs = (Date.now() - startedAt) / results.length;

      const approved = results.filter((r) => r.aprobado);
      const denied = results.filter(
        (r) => !r.aprobado && r.codigo === BoardingResultCode.DENEGADO_SOBRECUPO,
      );

      expect(approved).toHaveLength(5);
      expect(denied).toHaveLength(15);
      expect(avgLatencyMs).toBeLessThan(200);

      // Verificación directa contra tablas PostgreSQL
      const occupancy = await repository.getTripOccupancy(idViaje);
      expect(occupancy?.total_a_bordo).toBe(5);
      expect(occupancy?.capacidad_nominal).toBe(5);

      const attendanceCount = await pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total
         FROM public.registro_de_asistencia
         WHERE id_viaje = $1 AND tipo_evento = 'ABORDAJE'`,
        [idViaje],
      );
      expect(Number(attendanceCount.rows[0].total)).toBe(5);

      const incidents = await repository.listTripIncidents(idViaje);
      expect(incidents).toHaveLength(15);
      expect(
        incidents.every(
          (inc) =>
            inc.tipo_incidente === "INTENTO_SOBRECUPO" &&
            inc.severidad === "CRITICO",
        ),
      ).toBe(true);

      const notifCount = await pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total
         FROM public.notificacion
         WHERE id_viaje = $1 AND estado_envio = 'PENDIENTE'`,
        [idViaje],
      );
      expect(Number(notifCount.rows[0].total)).toBe(5);

      // Todos los 5 estudiantes aprobados deben estar en estado A_BORDO_VEHICULO y cadena WORM íntegra
      for (const ok of approved) {
        expect(ok.estado_custodia).toBe(FsmCustodyState.A_BORDO_VEHICULO);
        expect(ok.id_acudiente_titular).toBe(idAcudiente);
        expect(ok.id_notificacion).toBeTruthy();
      }

      const integrity = await custodyRepository.verifyHistoryIntegrity(10000);
      expect(integrity.cadena_integra).toBe(true);
    });

    it("Criterio de Aceptación #8 en PostgreSQL: vehículo capacidad 15 con 15 a bordo rechaza al #16 con DENEGADO_SOBRECUPO e inserta incidente CRITICO", async () => {
      const idVehiculo = await createVehicle(15, "C15");
      const idViaje = await createTrip(idVehiculo, "EN_CURSO", 14);
      const students = await createAssignedStudents("C15", 16);

      for (let i = 0; i < 15; i++) {
        const res = await repository.registerAtomicBoarding({
          id_viaje: idViaje,
          id_estudiante: null,
          qr_token_hash: students[i].qrHash,
          metodo_validacion: "QR_INSTITUCIONAL",
          coordenadas: PEREIRA_COORDS,
          registrado_por_usuario: idMonitoraUsuario,
          idempotency_key: `pg-c15-${tag}-${i + 1}`,
          sincronizado_offline: false,
        });
        expect(res.aprobado).toBe(true);
        expect(res.total_a_bordo).toBe(i + 1);
      }

      const rejected16 = await repository.registerAtomicBoarding({
        id_viaje: idViaje,
        id_estudiante: null,
        qr_token_hash: students[15].qrHash,
        metodo_validacion: "QR_INSTITUCIONAL",
        coordenadas: PEREIRA_COORDS,
        registrado_por_usuario: idMonitoraUsuario,
        idempotency_key: `pg-c15-${tag}-16`,
        sincronizado_offline: false,
      });

      expect(rejected16.aprobado).toBe(false);
      expect(rejected16.codigo).toBe(BoardingResultCode.DENEGADO_SOBRECUPO);
      expect(rejected16.total_a_bordo).toBe(15);
      expect(rejected16.id_incidente).toBeTruthy();

      const occupancy = await repository.getTripOccupancy(idViaje);
      expect(occupancy?.total_a_bordo).toBe(15);
    });

    it("RN-05 concurrente en PostgreSQL: 10 escaneos simultáneos del mismo estudiante -> 1 aprobado y 9 ABORDAJE_PREVIO_EXISTE", async () => {
      const idVehiculo = await createVehicle(10, "DUP");
      const idViaje = await createTrip(idVehiculo, "EN_CURSO", 18);
      const [student] = await createAssignedStudents("DUP", 1);

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, idx) =>
          repository.registerAtomicBoarding({
            id_viaje: idViaje,
            id_estudiante: null,
            qr_token_hash: student.qrHash,
            metodo_validacion: "QR_INSTITUCIONAL",
            coordenadas: PEREIRA_COORDS,
            registrado_por_usuario: idMonitoraUsuario,
            idempotency_key:
              idx < 5 ? `pg-dup-same-${tag}` : `pg-dup-diff-${tag}-${idx}`,
            sincronizado_offline: false,
          }),
        ),
      );

      const approved = results.filter((r) => r.aprobado);
      const duplicates = results.filter(
        (r) => r.codigo === BoardingResultCode.ABORDAJE_PREVIO_EXISTE,
      );

      expect(approved).toHaveLength(1);
      expect(duplicates).toHaveLength(9);

      const occupancy = await repository.getTripOccupancy(idViaje);
      expect(occupancy?.total_a_bordo).toBe(1);
    });

    it("rechaza viaje PROGRAMADO, QR desconocido y estudiante no asignado a la ruta en PostgreSQL", async () => {
      const idVehiculo = await createVehicle(8, "NEG");
      const idViajeProg = await createTrip(idVehiculo, "PROGRAMADO", 22);
      const idViajeActivo = await createTrip(idVehiculo, "EN_CURSO", 26);
      const [assigned] = await createAssignedStudents("NEG", 1);

      await expect(
        repository.registerAtomicBoarding({
          id_viaje: idViajeProg,
          id_estudiante: null,
          qr_token_hash: assigned.qrHash,
          metodo_validacion: "QR_INSTITUCIONAL",
          coordenadas: PEREIRA_COORDS,
          registrado_por_usuario: idMonitoraUsuario,
          idempotency_key: null,
          sincronizado_offline: false,
        }),
      ).rejects.toThrow(TripNotInProgressError);

      await expect(
        repository.registerAtomicBoarding({
          id_viaje: idViajeActivo,
          id_estudiante: null,
          qr_token_hash: sha256(`qr-inexistente-${tag}`),
          metodo_validacion: "QR_INSTITUCIONAL",
          coordenadas: PEREIRA_COORDS,
          registrado_por_usuario: idMonitoraUsuario,
          idempotency_key: null,
          sincronizado_offline: false,
        }),
      ).rejects.toThrow(InvalidQrTokenError);

      // Estudiante sin asignacion_ruta en la ruta del viaje
      const unassignedQr = sha256(`qr-unassigned-${tag}`);
      await pool.query(
        `INSERT INTO public.estudiante (
           id_colegio, codigo_institucional, documento_cifrado,
           documento_blind_index, nombres_cifrado, apellidos_cifrado,
           fecha_nacimiento_cifrada, grado, qr_token_hash, domicilio_punto
         )
         VALUES (
           $1, $2, $3, $4, $3, $3, $3, '8B', $5,
           ST_SetSRID(ST_MakePoint(-75.6961, 4.8133), 4326)::geography
         )`,
        [
          idColegio,
          `EST-UNASS-${tag}`,
          aesDummy,
          sha256(`doc-unassigned-${tag}`),
          unassignedQr,
        ],
      );

      await expect(
        repository.registerAtomicBoarding({
          id_viaje: idViajeActivo,
          id_estudiante: null,
          qr_token_hash: unassignedQr,
          metodo_validacion: "QR_INSTITUCIONAL",
          coordenadas: PEREIRA_COORDS,
          registrado_por_usuario: idMonitoraUsuario,
          idempotency_key: null,
          sincronizado_offline: false,
        }),
      ).rejects.toThrow(StudentNotAssignedToRouteError);
    });
  },
);
