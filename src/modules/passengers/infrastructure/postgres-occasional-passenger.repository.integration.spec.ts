import * as crypto from "crypto";
import { Pool } from "pg";
import { PostgresAttendanceRepository } from "../../attendance/infrastructure/postgres-attendance.repository";
import { FsmCustodyState } from "../../custody/domain/custody.types";
import {
  AbsenceIrreversibleError,
  CoordinatorNotAuthorizedForTripError,
  DuplicateOccasionalRequestError,
  GuardianNotAuthorizedForStudentError,
  OccasionalBookingRulesViolationError,
  OccasionalRejectionReason,
  OccasionalRequestStatus,
} from "../domain/occasional-passenger.types";
import { PostgresOccasionalPassengerRepository } from "./postgres-occasional-passenger.repository";

const runPostgres =
  process.env.RUN_POSTGRES_TESTS === "true" ||
  process.env.RUN_POSTGIS_TESTS === "true";
const describeIfPostgres = runPostgres ? describe : describe.skip;

/**
 * Pruebas de integración contra PostgreSQL 16 + PostGIS 3.4 real (Issue #11 - V018).
 * Se ejecutan con RUN_POSTGRES_TESTS=true tras aplicar V001..V018.
 */
describeIfPostgres(
  "PostgresOccasionalPassengerRepository & V018 — Reservas Transaccionales, Concurrencia y Rollback",
  () => {
    let pool: Pool;
    let repo: PostgresOccasionalPassengerRepository;
    let attendanceRepo: PostgresAttendanceRepository;

    const tag = crypto.randomBytes(4).toString("hex");
    const aesDummy = `v1:${"a".repeat(24)}:${"b".repeat(32)}:${"c".repeat(16)}`;
    const sha256Hex = (value: string) =>
      crypto.createHash("sha256").update(value, "utf8").digest("hex");

    let idColegio: string;
    let idOtroColegio: string;
    let idEmpresa: string;
    let idVehiculo: string;
    let idConductor: string;
    let idMonitoraUsuario: string;
    let idMonitora: string;
    let idCoordUsuario: string;
    let idCoordinador: string;
    let idOtroCoordUsuario: string;
    let idRutaManana: string;
    let idParada: string;

    async function createStudentWithGuardian(
      suffix: string,
      colegioId = idColegio,
    ) {
      const uRes = await pool.query<{ id_usuario: string }>(
        `INSERT INTO public.usuario (email, password_hash)
         VALUES ($1, 'hash_test') RETURNING id_usuario`,
        [`acu-p11-${tag}-${suffix}@test.co`],
      );
      const idUsuario = uRes.rows[0].id_usuario;

      const acuRes = await pool.query<{ id_acudiente: string }>(
        `INSERT INTO public.acudiente (
           id_usuario, nombres, apellidos, documento_cifrado, documento_blind_index,
           telefono_principal_cifrado, telefono_emergencia_cifrado, direccion_cifrada
         )
         VALUES ($1, 'Tutor', $2, $3, $4, $3, $3, $3)
         RETURNING id_acudiente`,
        [idUsuario, suffix, aesDummy, sha256Hex(`doc-acu-${tag}-${suffix}`)],
      );
      const idAcudiente = acuRes.rows[0].id_acudiente;

      const estRes = await pool.query<{ id_estudiante: string }>(
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
        [
          colegioId,
          `EST-P11-${tag}-${suffix}`,
          aesDummy,
          sha256Hex(`doc-est-${tag}-${suffix}`),
          sha256Hex(`qr-est-${tag}-${suffix}`),
        ],
      );
      const idEstudiante = estRes.rows[0].id_estudiante;

      await pool.query(
        `INSERT INTO public.estudiante_acudiente (
           id_estudiante, id_acudiente, parentesco, es_tutor_principal, orden_notificacion
         ) VALUES ($1, $2, 'MADRE', TRUE, 1)`,
        [idEstudiante, idAcudiente],
      );

      return { idUsuario, idAcudiente, idEstudiante };
    }

    async function createScheduledTrip(offsetDays: number) {
      const fechaDate = new Date(
        Date.UTC(2026, 11, 1 + offsetDays, 11, 30, 0),
      ); // 06:30 AM -05:00 = 11:30 UTC
      const fechaIso = fechaDate.toISOString().slice(0, 10);
      const inicioIso = fechaDate.toISOString();
      const finIso = new Date(fechaDate.getTime() + 60 * 60 * 1000).toISOString();

      const res = await pool.query<{ id_viaje: string }>(
        `INSERT INTO public.viaje (
           id_ruta, id_vehiculo, id_conductor, id_monitora, fecha,
           hora_inicio_programada, hora_fin_programada, estado
         )
         VALUES ($1, $2, $3, $4, $5::date, $6::timestamptz, $7::timestamptz, 'PROGRAMADO')
         RETURNING id_viaje`,
        [
          idRutaManana,
          idVehiculo,
          idConductor,
          idMonitora,
          fechaIso,
          inicioIso,
          finIso,
        ],
      );

      return {
        idViaje: res.rows[0].id_viaje,
        horaInicio: fechaDate,
      };
    }

    beforeAll(async () => {
      pool = new Pool({
        host: process.env.DB_HOST ?? "localhost",
        port: Number(process.env.DB_PORT ?? "5432"),
        database: process.env.DB_NAME ?? "camino_seguro_db",
        user: process.env.DB_USER ?? "app_user",
        password: process.env.DB_PASSWORD ?? "",
      });
      repo = new PostgresOccasionalPassengerRepository(pool, false);
      attendanceRepo = new PostgresAttendanceRepository(pool, false);

      const col = await pool.query<{ id_colegio: string }>(
        `INSERT INTO public.colegio (nombre, nit, direccion, telefono)
         VALUES ($1, $2, 'Carrera 7 No. 24-50', '3134567') RETURNING id_colegio`,
        [`Colegio P11 ${tag}`, `940${tag}-1`],
      );
      idColegio = col.rows[0].id_colegio;

      const col2 = await pool.query<{ id_colegio: string }>(
        `INSERT INTO public.colegio (nombre, nit, direccion, telefono)
         VALUES ($1, $2, 'Calle 20 No. 10-10', '3139999') RETURNING id_colegio`,
        [`Otro Colegio P11 ${tag}`, `941${tag}-2`],
      );
      idOtroColegio = col2.rows[0].id_colegio;

      const emp = await pool.query<{ id_empresa: string }>(
        `INSERT INTO public.empresa_transportadora (razon_social, nit, telefono, email_contacto)
         VALUES ($1, $2, '3245678', $3) RETURNING id_empresa`,
        [`Transportes P11 ${tag}`, `942${tag}-3`, `p11-${tag}@test.co`],
      );
      idEmpresa = emp.rows[0].id_empresa;

      // Vehículo con capacidad_nominal = 2
      const veh = await pool.query<{ id_vehiculo: string }>(
        `INSERT INTO public.vehiculo (
           id_empresa, placa, capacidad_nominal, numero_movil,
           modelo, tarjeta_operacion, imei_gps_fijo
         )
         VALUES ($1, $2, 2, $3, '2026', $4, $5)
         RETURNING id_vehiculo`,
        [
          idEmpresa,
          `P1${tag.slice(0, 4).toUpperCase()}`,
          `MP-${tag.slice(0, 4)}`,
          `TO-P11-${tag}`,
          `IMEI-P11-${tag}`,
        ],
      );
      idVehiculo = veh.rows[0].id_vehiculo;

      const uCond = await pool.query<{ id_usuario: string }>(
        `INSERT INTO public.usuario (email, password_hash)
         VALUES ($1, 'hash_test') RETURNING id_usuario`,
        [`cond-p11-${tag}@test.co`],
      );
      const cond = await pool.query<{ id_conductor: string }>(
        `INSERT INTO public.conductor (
           id_usuario, id_empresa, nombres, apellidos, numero_licencia, vigencia_licencia, telefono
         )
         VALUES ($1, $2, 'Pedro', 'Conductor', $3, CURRENT_DATE + INTERVAL '1 year', '3001111111')
         RETURNING id_conductor`,
        [uCond.rows[0].id_usuario, idEmpresa, `LIC-P11-${tag}`],
      );
      idConductor = cond.rows[0].id_conductor;

      const uMon = await pool.query<{ id_usuario: string }>(
        `INSERT INTO public.usuario (email, password_hash)
         VALUES ($1, 'hash_test') RETURNING id_usuario`,
        [`mon-p11-${tag}@test.co`],
      );
      idMonitoraUsuario = uMon.rows[0].id_usuario;
      const mon = await pool.query<{ id_monitora: string }>(
        `INSERT INTO public.monitora (
           id_usuario, id_empresa, nombres, apellidos, documento_cifrado, documento_blind_index, telefono
         )
         VALUES ($1, $2, 'Luisa', 'Monitora', $3, $4, '3002222222')
         RETURNING id_monitora`,
        [idMonitoraUsuario, idEmpresa, aesDummy, sha256Hex(`mon-p11-${tag}`)],
      );
      idMonitora = mon.rows[0].id_monitora;

      const uCoord = await pool.query<{ id_usuario: string }>(
        `INSERT INTO public.usuario (email, password_hash)
         VALUES ($1, 'hash_test') RETURNING id_usuario`,
        [`coord-p11-${tag}@test.co`],
      );
      idCoordUsuario = uCoord.rows[0].id_usuario;
      const coord = await pool.query<{ id_coordinador: string }>(
        `INSERT INTO public.coordinador (
           id_usuario, id_colegio, nombres, apellidos, cargo, telefono
         )
         VALUES ($1, $2, 'Marta', 'Coordinadora', 'Coordinadora Convivencia', '3003333333')
         RETURNING id_coordinador`,
        [idCoordUsuario, idColegio],
      );
      idCoordinador = coord.rows[0].id_coordinador;

      const uOtroCoord = await pool.query<{ id_usuario: string }>(
        `INSERT INTO public.usuario (email, password_hash)
         VALUES ($1, 'hash_test') RETURNING id_usuario`,
        [`otro-coord-p11-${tag}@test.co`],
      );
      idOtroCoordUsuario = uOtroCoord.rows[0].id_usuario;
      await pool.query(
        `INSERT INTO public.coordinador (
           id_usuario, id_colegio, nombres, apellidos, cargo, telefono
         )
         VALUES ($1, $2, 'Otro', 'Coordinador', 'Coordinador', '3004444444')`,
        [idOtroCoordUsuario, idOtroColegio],
      );

      const ruta = await pool.query<{ id_ruta: string }>(
        `INSERT INTO public.ruta (
           id_colegio, id_empresa, codigo, nombre, jornada,
           polilinea_oficial, origen_nombre, destino_nombre
         )
         VALUES (
           $1, $2, $3, 'Ruta Manana P11', 'MANANA',
           ST_GeogFromText('SRID=4326;LINESTRING(-75.6961 4.8133, -75.6946 4.8143)'),
           'Los Alamos', 'San Benito'
         )
         RETURNING id_ruta`,
        [idColegio, idEmpresa, `RP11-${tag}`],
      );
      idRutaManana = ruta.rows[0].id_ruta;

      const parada = await pool.query<{ id_parada: string }>(
        `INSERT INTO public.parada (
           id_ruta, nombre, orden_secuencia, punto_geografico,
           horario_estimado, radio_geocerca
         )
         VALUES (
           $1, 'Parada 1', 1,
           ST_GeogFromText('SRID=4326;POINT(-75.6961 4.8133)'),
           '06:30:00',
           ST_GeogFromText('SRID=4326;POLYGON((-75.697 4.812, -75.695 4.812, -75.695 4.814, -75.697 4.814, -75.697 4.812))')
         )
         RETURNING id_parada`,
        [idRutaManana],
      );
      idParada = parada.rows[0].id_parada;

      // Asignar 2 estudiantes regulares para llenar capacidad 2/2 en la ruta
      for (const sfx of ["reg1", "reg2"]) {
        const reg = await createStudentWithGuardian(sfx);
        await pool.query(
          `INSERT INTO public.asignacion_ruta (
             id_estudiante, id_ruta, id_parada_subida, id_parada_bajada, ciclo_horario, activa
           ) VALUES ($1, $2, $3, $3, 'AMBOS', TRUE)`,
          [reg.idEstudiante, idRutaManana, idParada],
        );
      }
    });

    afterAll(async () => {
      await pool.end();
    });

    it("Criterio de Aceptación + OWASP ASVS V4.1 + aprobación + irreversibilidad de inasistencia + abordaje QR V015", async () => {
      const { idViaje, horaInicio } = await createScheduledTrip(1);
      const guest = await createStudentWithGuardian("guest1");
      const intruder = await createStudentWithGuardian("intruder1");

      // 1. Criterio de Aceptación: 05:00 AM (1.5h antes de 06:30 AM) y 0 inasistencias -> ambos motivos
      const at0500 = new Date(horaInicio.getTime() - 90 * 60 * 1000);
      try {
        await repo.requestOccasionalSeat({
          id_viaje: idViaje,
          id_estudiante: guest.idEstudiante,
          solicitado_por_usuario: guest.idUsuario,
          qr_provisional_hash: sha256Hex(`qr-late-${tag}`),
          solicitado_en: at0500,
        });
        fail("Debió rechazar solicitud tardía sin vacante");
      } catch (error) {
        expect(error).toBeInstanceOf(OccasionalBookingRulesViolationError);
        const viol = error as OccasionalBookingRulesViolationError;
        expect(viol.motivos_rechazo).toContain(
          OccasionalRejectionReason.ANTELACION_INSUFICIENTE,
        );
        expect(viol.motivos_rechazo).toContain(
          OccasionalRejectionReason.SIN_VACANTE_POR_INASISTENCIA,
        );
      }

      // 2. Reportar inasistencia de uno de los regulares
      const regRow = await pool.query<{
        id_estudiante: string;
        id_acudiente: string;
      }>(
        `SELECT ar.id_estudiante, ea.id_acudiente
         FROM public.asignacion_ruta ar
         JOIN public.estudiante_acudiente ea ON ea.id_estudiante = ar.id_estudiante
         WHERE ar.id_ruta = $1
         LIMIT 1`,
        [idRutaManana],
      );
      const absentStudentId = regRow.rows[0].id_estudiante;
      const absentGuardianId = regRow.rows[0].id_acudiente;

      await pool.query(
        `INSERT INTO public.inasistencia (id_estudiante, id_viaje, reportado_por_acudiente, motivo, cupo_liberado)
         VALUES ($1, $2, $3, 'Cita medica', TRUE)`,
        [absentStudentId, idViaje, absentGuardianId],
      );

      // 3. OWASP ASVS V4.1: otro acudiente intenta solicitar para guest -> Forbidden
      const at0400 = new Date(horaInicio.getTime() - 150 * 60 * 1000);
      await expect(
        repo.requestOccasionalSeat({
          id_viaje: idViaje,
          id_estudiante: guest.idEstudiante,
          solicitado_por_usuario: intruder.idUsuario,
          qr_provisional_hash: sha256Hex(`qr-intruder-${tag}`),
          solicitado_en: at0400,
        }),
      ).rejects.toThrow(GuardianNotAuthorizedForStudentError);

      // 4. Acudiente legítimo solicita a las 04:00 AM (2.5h antes) -> RADICADA
      const provisionalHash = sha256Hex(`qr-ok-${tag}`);
      const req = await repo.requestOccasionalSeat({
        id_viaje: idViaje,
        id_estudiante: guest.idEstudiante,
        solicitado_por_usuario: guest.idUsuario,
        qr_provisional_hash: provisionalHash,
        motivo: "Actividad deportiva",
        solicitado_en: at0400,
      });

      expect(req.solicitud.estado_solicitud).toBe(
        OccasionalRequestStatus.RADICADA,
      );
      expect(req.solicitud.id_estudiante_que_libera_cupo).toBe(absentStudentId);
      expect(req.balance_vacantes.vacantes_netas).toBe(0);

      // 5. Mitigación de riesgo: trigger V018 impide revertir (DELETE o UPDATE cupo_liberado=FALSE) la inasistencia
      await expect(repo.revertAbsence(idViaje, absentStudentId)).rejects.toThrow(
        AbsenceIrreversibleError,
      );
      await expect(
        pool.query(
          `UPDATE public.inasistencia SET cupo_liberado = FALSE
           WHERE id_viaje = $1 AND id_estudiante = $2`,
          [idViaje, absentStudentId],
        ),
      ).rejects.toThrow(/INASISTENCIA_IRREVERSIBLE_CUPO_ASIGNADO/);

      // 6. Coordinador de otro colegio no puede aprobar -> CoordinatorNotAuthorizedForTripError
      await expect(
        repo.approveOccasionalSeat({
          id_pasajero_ocasional: req.solicitud.id_pasajero_ocasional,
          aprobado_por_usuario: idOtroCoordUsuario,
        }),
      ).rejects.toThrow(CoordinatorNotAuthorizedForTripError);

      // 7. Coordinador del colegio aprueba -> APROBADO_COORDINACION + inserción en viaje_estudiante
      const approved = await repo.approveOccasionalSeat({
        id_pasajero_ocasional: req.solicitud.id_pasajero_ocasional,
        aprobado_por_usuario: idCoordUsuario,
      });

      expect(approved.solicitud.estado_solicitud).toBe(
        OccasionalRequestStatus.APROBADO_COORDINACION,
      );
      expect(approved.solicitud.aprobado_por_coordinador).toBe(idCoordinador);
      expect(approved.lista_asistencia).toEqual({
        id_viaje: idViaje,
        id_estudiante: guest.idEstudiante,
        estado_custodia: FsmCustodyState.NO_INICIADO,
        es_pasajero_ocasional: true,
      });

      const manifest = await repo.listTripPassengerManifest(idViaje);
      expect(
        manifest.some(
          (m) =>
            m.id_estudiante === guest.idEstudiante &&
            m.es_pasajero_ocasional === true &&
            m.estado_custodia === FsmCustodyState.NO_INICIADO,
        ),
      ).toBe(true);

      // 8. Integración real con V015 (Issue #8): al pasar el viaje a EN_CURSO, el pasajero ocasional aborda con su QR provisional
      await pool.query(
        `UPDATE public.viaje SET estado = 'EN_CURSO' WHERE id_viaje = $1`,
        [idViaje],
      );
      const boarded = await attendanceRepo.registerAtomicBoarding({
        id_viaje: idViaje,
        id_estudiante: null,
        qr_token_hash: provisionalHash,
        metodo_validacion: "QR_OCASIONAL_TEMPORAL",
        coordenadas: { latitud: 4.8133, longitud: -75.6961 },
        registrado_por_usuario: idMonitoraUsuario,
        idempotency_key: `pg-p11-board-${tag}`,
        sincronizado_offline: false,
      });
      expect(boarded.aprobado).toBe(true);
      expect(boarded.metodo_validacion).toBe("QR_OCASIONAL_TEMPORAL");
      expect(boarded.estado_custodia).toBe(FsmCustodyState.A_BORDO_VEHICULO);

      const postBoardReq = await repo.findRequestById(
        req.solicitud.id_pasajero_ocasional,
      );
      expect(postBoardReq?.estado_solicitud).toBe(
        OccasionalRequestStatus.UTILIZADO,
      );
    });

    it("concurrencia real en PostgreSQL: 6 conexiones compiten por 1 única vacante -> estrictamente 1 aprobada y 5 rechazadas", async () => {
      const { idViaje, horaInicio } = await createScheduledTrip(2);
      const regRow = await pool.query<{
        id_estudiante: string;
        id_acudiente: string;
      }>(
        `SELECT ar.id_estudiante, ea.id_acudiente
         FROM public.asignacion_ruta ar
         JOIN public.estudiante_acudiente ea ON ea.id_estudiante = ar.id_estudiante
         WHERE ar.id_ruta = $1
         LIMIT 1`,
        [idRutaManana],
      );

      await pool.query(
        `INSERT INTO public.inasistencia (id_estudiante, id_viaje, reportado_por_acudiente, motivo, cupo_liberado)
         VALUES ($1, $2, $3, 'Permiso familiar', TRUE)`,
        [regRow.rows[0].id_estudiante, idViaje, regRow.rows[0].id_acudiente],
      );

      const at0400 = new Date(horaInicio.getTime() - 150 * 60 * 1000);
      const competitors = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          createStudentWithGuardian(`race-${i}`),
        ),
      );

      const settled = await Promise.allSettled(
        competitors.map((c, idx) =>
          repo.requestOccasionalSeat({
            id_viaje: idViaje,
            id_estudiante: c.idEstudiante,
            solicitado_por_usuario: c.idUsuario,
            qr_provisional_hash: sha256Hex(`qr-race-${tag}-${idx}`),
            solicitado_en: at0400,
          }),
        ),
      );

      const fulfilled = settled.filter((r) => r.status === "fulfilled");
      const rejected = settled.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(5);

      const dbCount = await pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM public.pasajero_ocasional WHERE id_viaje = $1`,
        [idViaje],
      );
      expect(Number(dbCount.rows[0].total)).toBe(1);
    });

    it("rollback transaccional real en PostgreSQL: fallo al insertar viaje_estudiante revierte UPDATE de pasajero_ocasional", async () => {
      const { idViaje, horaInicio } = await createScheduledTrip(3);
      const guest = await createStudentWithGuardian("rollback1");

      const regRow = await pool.query<{
        id_estudiante: string;
        id_acudiente: string;
      }>(
        `SELECT ar.id_estudiante, ea.id_acudiente
         FROM public.asignacion_ruta ar
         JOIN public.estudiante_acudiente ea ON ea.id_estudiante = ar.id_estudiante
         WHERE ar.id_ruta = $1
         LIMIT 1`,
        [idRutaManana],
      );

      await pool.query(
        `INSERT INTO public.inasistencia (id_estudiante, id_viaje, reportado_por_acudiente, motivo, cupo_liberado)
         VALUES ($1, $2, $3, 'Viaje familiar', TRUE)`,
        [regRow.rows[0].id_estudiante, idViaje, regRow.rows[0].id_acudiente],
      );

      const at0400 = new Date(horaInicio.getTime() - 150 * 60 * 1000);
      const req = await repo.requestOccasionalSeat({
        id_viaje: idViaje,
        id_estudiante: guest.idEstudiante,
        solicitado_por_usuario: guest.idUsuario,
        qr_provisional_hash: sha256Hex(`qr-rb-${tag}`),
        solicitado_en: at0400,
      });

      // Provocar conflicto a mitad de fn_aprobar_pasajero_ocasional (después del UPDATE a APROBADO_COORDINACION)
      // insertando previamente la fila en viaje_estudiante
      await pool.query(
        `INSERT INTO public.viaje_estudiante (id_viaje, id_estudiante, estado_custodia, es_pasajero_ocasional)
         VALUES ($1, $2, 'NO_INICIADO', FALSE)`,
        [idViaje, guest.idEstudiante],
      );

      await expect(
        repo.approveOccasionalSeat({
          id_pasajero_ocasional: req.solicitud.id_pasajero_ocasional,
          aprobado_por_usuario: idCoordUsuario,
        }),
      ).rejects.toThrow(DuplicateOccasionalRequestError);

      // Confirmar que PostgreSQL revirtió completamente el UPDATE de pasajero_ocasional
      const afterRollback = await repo.findRequestById(
        req.solicitud.id_pasajero_ocasional,
      );
      expect(afterRollback?.estado_solicitud).toBe(
        OccasionalRequestStatus.RADICADA,
      );
      expect(afterRollback?.aprobado_en).toBeNull();
      expect(afterRollback?.aprobado_por_coordinador).toBeNull();
    });
  },
);
