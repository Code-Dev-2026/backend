import * as crypto from "crypto";
import { Pool } from "pg";
import {
  DisembarkOutcomeType,
  JudicialAlertBlockedError,
  ReceptorType,
} from "../../../attendance/domain/disembark.types";
import { PostgresAttendanceRepository } from "../../../attendance/infrastructure/postgres-attendance.repository";
import { PostgresJudicialAlertRepository } from "./postgres-judicial-alert.repository";

const runPostgres =
  process.env.RUN_POSTGRES_TESTS === "true" ||
  process.env.RUN_POSTGIS_TESTS === "true";
const describeIfPostgres = runPostgres ? describe : describe.skip;

const STOP_COORDS = { latitud: 4.8133, longitud: -75.6961 };
const SCHOOL_COORDS = { latitud: 4.8143, longitud: -75.6946 };

/**
 * Pruebas de integración contra PostgreSQL 16 + PostGIS 3.4 real (Issue #10 - V017).
 * Se ejecutan con RUN_POSTGRES_TESTS=true tras aplicar V001..V017.
 */
describeIfPostgres(
  "PostgresJudicialAlertRepository & V017 — Defensa en Profundidad contra Alertas Judiciales",
  () => {
    let pool: Pool;
    let judicialRepo: PostgresJudicialAlertRepository;
    let attendanceRepo: PostgresAttendanceRepository;
    const tag = crypto.randomBytes(4).toString("hex");
    const todayIso = new Date().toISOString().slice(0, 10);
    const aesDummy = `v1:${"a".repeat(24)}:${"b".repeat(32)}:${"c".repeat(16)}`;
    const hmacLike = (value: string) =>
      crypto
        .createHmac("sha256", "pg-test-issue-10-hmac-key")
        .update(value.toUpperCase(), "utf8")
        .digest("hex");

    let idColegio: string;
    let idEmpresa: string;
    let idVehiculo: string;
    let idConductor: string;
    let idMonitoraUsuario: string;
    let idMonitora: string;
    let idRectoriaUsuario: string;
    let idRutaTarde: string;
    let idParada: string;
    let idMadre: string;
    let idPadreRestringido: string;
    let madreHash: string;
    let padreRestringidoHash: string;

    beforeAll(async () => {
      pool = new Pool({
        host: process.env.DB_HOST ?? "localhost",
        port: Number(process.env.DB_PORT ?? "5432"),
        database: process.env.DB_NAME ?? "camino_seguro_db",
        user: process.env.DB_USER ?? "app_user",
        password: process.env.DB_PASSWORD ?? "",
      });
      judicialRepo = new PostgresJudicialAlertRepository(pool, false);
      attendanceRepo = new PostgresAttendanceRepository(pool, false);

      const col = await pool.query<{ id_colegio: string }>(
        `INSERT INTO public.colegio (nombre, nit, direccion, telefono)
         VALUES ($1, $2, 'Carrera 7 No. 24-50, Pereira', '3134567')
         RETURNING id_colegio`,
        [`Colegio Jud ${tag}`, `930${tag}-1`],
      );
      idColegio = col.rows[0].id_colegio;

      const emp = await pool.query<{ id_empresa: string }>(
        `INSERT INTO public.empresa_transportadora (razon_social, nit, telefono, email_contacto)
         VALUES ($1, $2, '3245678', $3)
         RETURNING id_empresa`,
        [`Transportes Jud ${tag}`, `931${tag}-2`, `jud-${tag}@test.co`],
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
          `JD${tag.slice(0, 4).toUpperCase()}`,
          `MJ-${tag.slice(0, 4)}`,
          `TO-JUD-${tag}`,
          `IMEI-JUD-${tag}`,
        ],
      );
      idVehiculo = veh.rows[0].id_vehiculo;

      const uCond = await pool.query<{ id_usuario: string }>(
        `INSERT INTO public.usuario (email, password_hash)
         VALUES ($1, 'hash_test') RETURNING id_usuario`,
        [`cond-jud-${tag}@test.co`],
      );
      const cond = await pool.query<{ id_conductor: string }>(
        `INSERT INTO public.conductor (
           id_usuario, id_empresa, nombres, apellidos, numero_licencia, vigencia_licencia, telefono
         )
         VALUES ($1, $2, 'Luis', 'Conductor', $3, CURRENT_DATE + INTERVAL '1 year', '3001111111')
         RETURNING id_conductor`,
        [uCond.rows[0].id_usuario, idEmpresa, `LIC-JUD-${tag}`],
      );
      idConductor = cond.rows[0].id_conductor;

      const uMon = await pool.query<{ id_usuario: string }>(
        `INSERT INTO public.usuario (email, password_hash)
         VALUES ($1, 'hash_test') RETURNING id_usuario`,
        [`mon-jud-${tag}@test.co`],
      );
      idMonitoraUsuario = uMon.rows[0].id_usuario;

      const mon = await pool.query<{ id_monitora: string }>(
        `INSERT INTO public.monitora (
           id_usuario, id_empresa, nombres, apellidos, documento_cifrado, documento_blind_index, telefono
         )
         VALUES ($1, $2, 'Rosa', 'Monitora', $3, $4, '3002222222')
         RETURNING id_monitora`,
        [idMonitoraUsuario, idEmpresa, aesDummy, hmacLike(`mon-jud-${tag}`)],
      );
      idMonitora = mon.rows[0].id_monitora;

      const uRect = await pool.query<{ id_usuario: string }>(
        `INSERT INTO public.usuario (email, password_hash)
         VALUES ($1, 'hash_test') RETURNING id_usuario`,
        [`rect-jud-${tag}@test.co`],
      );
      idRectoriaUsuario = uRect.rows[0].id_usuario;

      const uMadre = await pool.query<{ id_usuario: string }>(
        `INSERT INTO public.usuario (email, password_hash)
         VALUES ($1, 'hash_test') RETURNING id_usuario`,
        [`madre-jud-${tag}@test.co`],
      );
      madreHash = hmacLike(`52987654-${tag}`);
      const madre = await pool.query<{ id_acudiente: string }>(
        `INSERT INTO public.acudiente (
           id_usuario, nombres, apellidos, documento_cifrado, documento_blind_index,
           telefono_principal_cifrado, telefono_emergencia_cifrado, direccion_cifrada
         )
         VALUES ($1, 'Carolina', 'Madre', $2, $3, $2, $2, $2)
         RETURNING id_acudiente`,
        [uMadre.rows[0].id_usuario, aesDummy, madreHash],
      );
      idMadre = madre.rows[0].id_acudiente;

      const uPadre = await pool.query<{ id_usuario: string }>(
        `INSERT INTO public.usuario (email, password_hash)
         VALUES ($1, 'hash_test') RETURNING id_usuario`,
        [`padre-jud-${tag}@test.co`],
      );
      padreRestringidoHash = hmacLike(`79123456-${tag}`);
      const padre = await pool.query<{ id_acudiente: string }>(
        `INSERT INTO public.acudiente (
           id_usuario, nombres, apellidos, documento_cifrado, documento_blind_index,
           telefono_principal_cifrado, telefono_emergencia_cifrado, direccion_cifrada
         )
         VALUES ($1, 'Carlos', 'Progenitor', $2, $3, $2, $2, $2)
         RETURNING id_acudiente`,
        [uPadre.rows[0].id_usuario, aesDummy, padreRestringidoHash],
      );
      idPadreRestringido = padre.rows[0].id_acudiente;

      const ruta = await pool.query<{ id_ruta: string }>(
        `INSERT INTO public.ruta (
           id_colegio, id_empresa, codigo, nombre, jornada,
           polilinea_oficial, origen_nombre, destino_nombre
         )
         VALUES (
           $1, $2, $3, 'Ruta Tarde Jud', 'TARDE',
           ST_GeogFromText('SRID=4326;LINESTRING(-75.6946 4.8143, -75.6961 4.8133)'),
           'San Benito', 'Los Alamos'
         )
         RETURNING id_ruta`,
        [idColegio, idEmpresa, `RJUD-${tag}`],
      );
      idRutaTarde = ruta.rows[0].id_ruta;

      const parada = await pool.query<{ id_parada: string }>(
        `INSERT INTO public.parada (
           id_ruta, nombre, orden_secuencia, punto_geografico,
           horario_estimado, radio_geocerca
         )
         VALUES (
           $1, 'Parada Domicilio', 1,
           ST_GeogFromText('SRID=4326;POINT(-75.6961 4.8133)'),
           '15:20:00',
           ST_GeogFromText('SRID=4326;POLYGON((-75.697 4.812, -75.695 4.812, -75.695 4.814, -75.697 4.814, -75.697 4.812))')
         )
         RETURNING id_parada`,
        [idRutaTarde],
      );
      idParada = parada.rows[0].id_parada;
    });

    afterAll(async () => {
      await pool.end();
    });

    it("verifica documento_restringido_hash, bloqueo en fn_registrar_descenso_atomico, trigger en entrega, incidente y SMS solo a la madre", async () => {
      const qrHash = hmacLike(`qr-jud-pg-${tag}`);
      const est = await pool.query<{ id_estudiante: string }>(
        `INSERT INTO public.estudiante (
           id_colegio, codigo_institucional, documento_cifrado,
           documento_blind_index, nombres_cifrado, apellidos_cifrado,
           fecha_nacimiento_cifrada, grado, qr_token_hash, domicilio_punto
         )
         VALUES (
           $1, $2, $3, $4, $3, $3, $3, '5A', $5,
           ST_SetSRID(ST_MakePoint(-75.6961, 4.8133), 4326)::geography
         )
         RETURNING id_estudiante`,
        [
          idColegio,
          `EST-JUD-${tag}`,
          aesDummy,
          hmacLike(`doc-est-jud-${tag}`),
          qrHash,
        ],
      );
      const idEstudiante = est.rows[0].id_estudiante;

      await pool.query(
        `INSERT INTO public.asignacion_ruta (
           id_estudiante, id_ruta, id_parada_subida, id_parada_bajada, ciclo_horario, activa
         ) VALUES ($1, $2, $3, $3, 'AMBOS', TRUE)`,
        [idEstudiante, idRutaTarde, idParada],
      );
      await pool.query(
        `INSERT INTO public.estudiante_acudiente (
           id_estudiante, id_acudiente, parentesco, es_tutor_principal, orden_notificacion
         ) VALUES ($1, $2, 'MADRE', TRUE, 1), ($1, $3, 'PADRE', FALSE, 2)`,
        [idEstudiante, idMadre, idPadreRestringido],
      );

      // 1. Crear alerta judicial mediante PostgresJudicialAlertRepository
      const alert = await judicialRepo.create({
        id_estudiante: idEstudiante,
        juzgado_emisor: "Comisaría Primera de Familia de Pereira",
        radicado_medida: `CFP-PG-${tag}`,
        foto_individuo_cifrada: aesDummy,
        individuo_restringido_nombre_cifrado: aesDummy,
        individuo_restringido_documento_cifrado: aesDummy,
        individuo_blind_index: padreRestringidoHash,
        orden_judicial_resumen_cifrado: aesDummy,
        registrado_por_rectoria: idRectoriaUsuario,
        hash_integridad_sha256: hmacLike(`integridad-${tag}`),
      });
      expect(alert.documento_restringido_hash).toBe(padreRestringidoHash);

      const match = await judicialRepo.findActiveMatchByBlindIndex(
        idEstudiante,
        padreRestringidoHash,
      );
      expect(match?.bloqueada).toBe(true);
      expect(match?.radicado_medida).toBe(`CFP-PG-${tag}`);

      // 2. Crear viaje y verificar que el abordaje NO se bloquea
      const viajeRes = await pool.query<{ id_viaje: string }>(
        `INSERT INTO public.viaje (
           id_ruta, id_vehiculo, id_conductor, id_monitora, fecha,
           hora_inicio_programada, hora_fin_programada, estado
         )
         VALUES (
           $1, $2, $3, $4, $5::date,
           NOW() + INTERVAL '40 hours', NOW() + INTERVAL '41 hours', 'EN_CURSO'
         )
         RETURNING id_viaje`,
        [idRutaTarde, idVehiculo, idConductor, idMonitora, todayIso],
      );
      const idViaje = viajeRes.rows[0].id_viaje;

      const boarded = await attendanceRepo.registerAtomicBoarding({
        id_viaje: idViaje,
        id_estudiante: null,
        qr_token_hash: qrHash,
        metodo_validacion: "QR_INSTITUCIONAL",
        coordenadas: SCHOOL_COORDS,
        registrado_por_usuario: idMonitoraUsuario,
        idempotency_key: `pg-jud-board-${tag}`,
        sincronizado_offline: false,
      });
      expect(boarded.aprobado).toBe(true);
      expect(boarded.total_a_bordo).toBe(1);

      // 3. fn_registrar_descenso_atomico rechaza categóricamente al progenitor restringido
      await expect(
        attendanceRepo.registerAtomicDisembark({
          id_viaje: idViaje,
          id_estudiante: idEstudiante,
          resultado_entrega: DisembarkOutcomeType.ENTREGADO_EXITOSO,
          tipo_receptor: ReceptorType.ACUDIENTE,
          receptor_documento_blind_index: padreRestringidoHash,
          id_receptor: idPadreRestringido,
          metodo_validacion: "VERIFICACION_VISUAL_PARADA",
          coordenadas: STOP_COORDS,
          registrado_por_usuario: idMonitoraUsuario,
          foto_evidencia_url: null,
          observaciones_fallido: null,
          idempotency_key: null,
          sincronizado_offline: false,
        }),
      ).rejects.toThrow(JudicialAlertBlockedError);

      // 4. Defensa en profundidad: incluso un INSERT directo en `entrega` falla por trigger V017
      await expect(
        pool.query(
          `INSERT INTO public.entrega (
             id_viaje, id_estudiante, intento_secuencia, tipo_receptor,
             id_acudiente, id_autorizado, estado_entrega, coordenada
           )
           VALUES (
             $1, $2, 1, 'ACUDIENTE', $3, NULL, 'ENTREGADO_EXITOSO',
             ST_SetSRID(ST_MakePoint(-75.6961, 4.8133), 4326)::geography
           )`,
          [idViaje, idEstudiante, idPadreRestringido],
        ),
      ).rejects.toThrow(/ALERTA_JUDICIAL_BLOQUEANTE/);

      // 5. fn_registrar_incidente_alerta_judicial registra incidente CRITICO y SMS solo a la madre
      const emergency =
        await judicialRepo.recordJudicialBlockIncidentAndNotifications({
          id_viaje: idViaje,
          id_estudiante: idEstudiante,
          id_alerta: alert.id_alerta,
          documento_restringido_hash: padreRestringidoHash,
          radicado_medida: alert.radicado_medida,
          juzgado_emisor: alert.juzgado_emisor,
          latitud: STOP_COORDS.latitud,
          longitud: STOP_COORDS.longitud,
          registrado_por_usuario: idMonitoraUsuario,
        });

      expect(emergency.id_incidente).toBeTruthy();
      expect(emergency.id_acudientes_notificados).toEqual([idMadre]);
      expect(emergency.notificaciones_creadas).toBe(1);
      expect(emergency.alerta_policia_infancia_registrada).toBe(true);

      // 6. Entrega posterior a la madre (no restringida) funciona correctamente
      const motherOk = await attendanceRepo.registerAtomicDisembark({
        id_viaje: idViaje,
        id_estudiante: idEstudiante,
        resultado_entrega: DisembarkOutcomeType.ENTREGADO_EXITOSO,
        tipo_receptor: ReceptorType.ACUDIENTE,
        receptor_documento_blind_index: madreHash,
        id_receptor: idMadre,
        metodo_validacion: "VERIFICACION_VISUAL_PARADA",
        coordenadas: STOP_COORDS,
        registrado_por_usuario: idMonitoraUsuario,
        foto_evidencia_url: null,
        observaciones_fallido: null,
        idempotency_key: `pg-jud-mother-ok-${tag}`,
        sincronizado_offline: false,
      });
      expect(motherOk.aprobado).toBe(true);
      expect(motherOk.total_a_bordo).toBe(0);
    });
  },
);
