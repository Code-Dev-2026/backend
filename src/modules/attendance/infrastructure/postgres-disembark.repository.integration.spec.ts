import * as crypto from "crypto";
import { Pool } from "pg";
import { TripStateEnum } from "@common/enums/trip-state.enum";
import {
  FsmCustodyState,
  TripClosureBlockedError,
} from "../../custody/domain/custody.types";
import { PostgresCustodyRepository } from "../../custody/infrastructure/postgres-custody.repository";
import {
  AuthorizationExpiredError,
  DisembarkOutcomeType,
  DisembarkResultCode,
  JudicialAlertBlockedError,
  ReceptorType,
  ReceptorUnauthorizedError,
} from "../domain/disembark.types";
import { PostgresAttendanceRepository } from "./postgres-attendance.repository";

const runPostgres =
  process.env.RUN_POSTGRES_TESTS === "true" ||
  process.env.RUN_POSTGIS_TESTS === "true";
const describeIfPostgres = runPostgres ? describe : describe.skip;

const PEREIRA_HOME = { latitud: 4.8133, longitud: -75.6961 };
const SAN_BENITO = { latitud: 4.8143, longitud: -75.6946 };

/**
 * Pruebas de integración contra PostgreSQL 16 + PostGIS 3.4 real (Issue #9 - V016).
 * Se ejecutan con RUN_POSTGRES_TESTS=true tras aplicar V001..V016.
 */
describeIfPostgres(
  "PostgresAttendanceRepository — Desembarque seguro y retorno a sede (V016)",
  () => {
    let pool: Pool;
    let repository: PostgresAttendanceRepository;
    let custodyRepository: PostgresCustodyRepository;
    const tag = crypto.randomBytes(4).toString("hex");
    const todayIso = new Date().toISOString().slice(0, 10);
    const aesDummy = `v1:${"a".repeat(24)}:${"b".repeat(32)}:${"c".repeat(16)}`;
    const sha256 = (value: string) =>
      crypto.createHash("sha256").update(value, "utf8").digest("hex");

    let idColegio: string;
    let idEmpresa: string;
    let idVehiculo: string;
    let idConductor: string;
    let idMonitoraUsuario: string;
    let idMonitora: string;
    let idCoordinadorUsuario: string;
    let idCoordinador: string;
    let idRutaTarde: string;
    let idParada: string;
    let idAcudiente: string;
    let acudienteBlindIndex: string;

    beforeAll(async () => {
      pool = new Pool({
        host: process.env.DB_HOST ?? "localhost",
        port: Number(process.env.DB_PORT ?? "5432"),
        database: process.env.DB_NAME ?? "camino_seguro_db",
        user: process.env.DB_USER ?? "app_user",
        password: process.env.DB_PASSWORD ?? "",
      });
      repository = new PostgresAttendanceRepository(pool, false);
      custodyRepository = new PostgresCustodyRepository(pool, false);

      const col = await pool.query<{ id_colegio: string }>(
        `INSERT INTO public.colegio (nombre, nit, direccion, telefono)
         VALUES ($1, $2, 'Carrera 7 No. 24-50, Pereira', '3134567')
         RETURNING id_colegio`,
        [`Colegio Dis ${tag}`, `920${tag}-1`],
      );
      idColegio = col.rows[0].id_colegio;

      const emp = await pool.query<{ id_empresa: string }>(
        `INSERT INTO public.empresa_transportadora (razon_social, nit, telefono, email_contacto)
         VALUES ($1, $2, '3245678', $3)
         RETURNING id_empresa`,
        [`Transportes Dis ${tag}`, `921${tag}-2`, `dis-${tag}@test.co`],
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
          `DS${tag.slice(0, 4).toUpperCase()}`,
          `MD-${tag.slice(0, 4)}`,
          `TO-DIS-${tag}`,
          `IMEI-DIS-${tag}`,
        ],
      );
      idVehiculo = veh.rows[0].id_vehiculo;

      const uCond = await pool.query<{ id_usuario: string }>(
        `INSERT INTO public.usuario (email, password_hash)
         VALUES ($1, 'hash_test') RETURNING id_usuario`,
        [`cond-dis-${tag}@test.co`],
      );
      const cond = await pool.query<{ id_conductor: string }>(
        `INSERT INTO public.conductor (
           id_usuario, id_empresa, nombres, apellidos, numero_licencia, vigencia_licencia, telefono
         )
         VALUES ($1, $2, 'Luis', 'Conductor', $3, CURRENT_DATE + INTERVAL '1 year', '3001111111')
         RETURNING id_conductor`,
        [uCond.rows[0].id_usuario, idEmpresa, `LIC-DIS-${tag}`],
      );
      idConductor = cond.rows[0].id_conductor;

      const uMon = await pool.query<{ id_usuario: string }>(
        `INSERT INTO public.usuario (email, password_hash)
         VALUES ($1, 'hash_test') RETURNING id_usuario`,
        [`mon-dis-${tag}@test.co`],
      );
      idMonitoraUsuario = uMon.rows[0].id_usuario;

      const mon = await pool.query<{ id_monitora: string }>(
        `INSERT INTO public.monitora (
           id_usuario, id_empresa, nombres, apellidos, documento_cifrado, documento_blind_index, telefono
         )
         VALUES ($1, $2, 'Rosa', 'Monitora', $3, $4, '3002222222')
         RETURNING id_monitora`,
        [idMonitoraUsuario, idEmpresa, aesDummy, sha256(`mon-dis-${tag}`)],
      );
      idMonitora = mon.rows[0].id_monitora;

      const uCoord = await pool.query<{ id_usuario: string }>(
        `INSERT INTO public.usuario (email, password_hash)
         VALUES ($1, 'hash_test') RETURNING id_usuario`,
        [`coord-dis-${tag}@test.co`],
      );
      idCoordinadorUsuario = uCoord.rows[0].id_usuario;
      const coord = await pool.query<{ id_coordinador: string }>(
        `INSERT INTO public.coordinador (
           id_usuario, id_colegio, nombres, apellidos, cargo, telefono
         )
         VALUES ($1, $2, 'Elena', 'Coordinadora', 'Coordinadora Convivencia', '3003333333')
         RETURNING id_coordinador`,
        [idCoordinadorUsuario, idColegio],
      );
      idCoordinador = coord.rows[0].id_coordinador;

      const uAcud = await pool.query<{ id_usuario: string }>(
        `INSERT INTO public.usuario (email, password_hash)
         VALUES ($1, 'hash_test') RETURNING id_usuario`,
        [`acud-dis-${tag}@test.co`],
      );
      acudienteBlindIndex = sha256(`acud-doc-dis-${tag}`);
      const acud = await pool.query<{ id_acudiente: string }>(
        `INSERT INTO public.acudiente (
           id_usuario, nombres, apellidos, documento_cifrado, documento_blind_index,
           telefono_principal_cifrado, telefono_emergencia_cifrado, direccion_cifrada
         )
         VALUES ($1, 'Patricia', 'Acudiente', $2, $3, $2, $2, $2)
         RETURNING id_acudiente`,
        [uAcud.rows[0].id_usuario, aesDummy, acudienteBlindIndex],
      );
      idAcudiente = acud.rows[0].id_acudiente;

      const ruta = await pool.query<{ id_ruta: string }>(
        `INSERT INTO public.ruta (
           id_colegio, id_empresa, codigo, nombre, jornada,
           polilinea_oficial, origen_nombre, destino_nombre
         )
         VALUES (
           $1, $2, $3, 'Ruta Tarde Dis', 'TARDE',
           ST_GeogFromText('SRID=4326;LINESTRING(-75.6946 4.8143, -75.6961 4.8133)'),
           'San Benito', 'Los Alamos'
         )
         RETURNING id_ruta`,
        [idColegio, idEmpresa, `RDIS-${tag}`],
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

    async function createBoardedStudent(
      idViaje: string,
      suffix: string,
    ): Promise<string> {
      const qrHash = sha256(`qr-dis-${tag}-${suffix}`);
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
          `EST-DIS-${tag}-${suffix}`,
          aesDummy,
          sha256(`doc-est-dis-${tag}-${suffix}`),
          qrHash,
        ],
      );
      const idEstudiante = est.rows[0].id_estudiante;

      await pool.query(
        `INSERT INTO public.asignacion_ruta (
           id_estudiante, id_ruta, id_parada_subida, id_parada_bajada, ciclo_horario, activa
         )
         VALUES ($1, $2, $3, $3, 'AMBOS', TRUE)`,
        [idEstudiante, idRutaTarde, idParada],
      );

      await pool.query(
        `INSERT INTO public.estudiante_acudiente (
           id_estudiante, id_acudiente, parentesco, es_tutor_principal, orden_notificacion
         )
         VALUES ($1, $2, 'MADRE', TRUE, 1)`,
        [idEstudiante, idAcudiente],
      );

      const boarded = await repository.registerAtomicBoarding({
        id_viaje: idViaje,
        id_estudiante: null,
        qr_token_hash: qrHash,
        metodo_validacion: "QR_INSTITUCIONAL",
        coordenadas: SAN_BENITO,
        registrado_por_usuario: idMonitoraUsuario,
        idempotency_key: `pg-dis-board-${tag}-${suffix}`,
        sincronizado_offline: false,
      });
      expect(boarded.aprobado).toBe(true);
      return idEstudiante;
    }

    it("verifica entregas con autorizado vigente, vencido, inexistente, alerta judicial y ciclo completo de retorno seguro a sede en PostgreSQL 16", async () => {
      const viajeRes = await pool.query<{ id_viaje: string }>(
        `INSERT INTO public.viaje (
           id_ruta, id_vehiculo, id_conductor, id_monitora, fecha,
           hora_inicio_programada, hora_fin_programada, estado
         )
         VALUES (
           $1, $2, $3, $4, $5::date,
           NOW() + INTERVAL '30 hours', NOW() + INTERVAL '31 hours', 'EN_CURSO'
         )
         RETURNING id_viaje`,
        [idRutaTarde, idVehiculo, idConductor, idMonitora, todayIso],
      );
      const idViaje = viajeRes.rows[0].id_viaje;

      const s1 = await createBoardedStudent(idViaje, "1");
      const s2 = await createBoardedStudent(idViaje, "2");

      const validBlind = sha256(`auth-valid-${tag}`);
      const expiredBlind = sha256(`auth-expired-${tag}`);
      const judicialBlind = sha256(`judicial-${tag}`);

      const authValid = await pool.query<{ id_autorizado: string }>(
        `INSERT INTO public.adulto_autorizado (
           nombres, apellidos, documento_cifrado, documento_blind_index, telefono_cifrado, activo
         )
         VALUES ('Abuela', 'Vigente', $1, $2, $1, TRUE)
         RETURNING id_autorizado`,
        [aesDummy, validBlind],
      );
      const authExpired = await pool.query<{ id_autorizado: string }>(
        `INSERT INTO public.adulto_autorizado (
           nombres, apellidos, documento_cifrado, documento_blind_index, telefono_cifrado, activo
         )
         VALUES ('Tio', 'Vencido', $1, $2, $1, TRUE)
         RETURNING id_autorizado`,
        [aesDummy, expiredBlind],
      );

      await pool.query(
        `INSERT INTO public.estudiante_autorizado (
           id_estudiante, id_autorizado, autorizado_por, parentesco, prioridad_retiro, activo, autorizado_hasta
         )
         VALUES ($1, $2, $3, 'ABUELA', 1, TRUE, NOW() + INTERVAL '1 day'),
                ($1, $4, $3, 'TIO', 2, TRUE, NOW() - INTERVAL '1 hour')`,
        [
          s1,
          authValid.rows[0].id_autorizado,
          idAcudiente,
          authExpired.rows[0].id_autorizado,
        ],
      );

      await pool.query(
        `INSERT INTO public.alerta_judicial (
           id_estudiante, juzgado_emisor, radicado_medida, foto_individuo_cifrada,
           individuo_restringido_nombre_cifrado, individuo_restringido_documento_cifrado,
           individuo_blind_index, orden_judicial_resumen_cifrado, activa,
           registrado_por_rectoria, hash_integridad_sha256
         )
         VALUES ($1, 'Juzgado 1 Familia', $2, $3, $3, $3, $4, $3, TRUE, $5, $6)`,
        [
          s1,
          `RAD-PG-${tag}`,
          aesDummy,
          judicialBlind,
          idCoordinadorUsuario,
          sha256(`alerta-${tag}`),
        ],
      );

      // 1. Autorizado vencido -> rechazado
      await expect(
        repository.registerAtomicDisembark({
          id_viaje: idViaje,
          id_estudiante: s1,
          resultado_entrega: DisembarkOutcomeType.ENTREGADO_EXITOSO,
          tipo_receptor: ReceptorType.ADULTO_AUTORIZADO,
          receptor_documento_blind_index: expiredBlind,
          id_receptor: null,
          metodo_validacion: "VERIFICACION_VISUAL_PARADA",
          coordenadas: PEREIRA_HOME,
          registrado_por_usuario: idMonitoraUsuario,
          foto_evidencia_url: null,
          observaciones_fallido: null,
          idempotency_key: null,
          sincronizado_offline: false,
        }),
      ).rejects.toThrow(AuthorizationExpiredError);

      // 2. Autorizado inexistente -> rechazado
      await expect(
        repository.registerAtomicDisembark({
          id_viaje: idViaje,
          id_estudiante: s1,
          resultado_entrega: DisembarkOutcomeType.ENTREGADO_EXITOSO,
          tipo_receptor: ReceptorType.ADULTO_AUTORIZADO,
          receptor_documento_blind_index: sha256(`no-existe-${tag}`),
          id_receptor: null,
          metodo_validacion: "VERIFICACION_VISUAL_PARADA",
          coordenadas: PEREIRA_HOME,
          registrado_por_usuario: idMonitoraUsuario,
          foto_evidencia_url: null,
          observaciones_fallido: null,
          idempotency_key: null,
          sincronizado_offline: false,
        }),
      ).rejects.toThrow(ReceptorUnauthorizedError);

      // 3. Alerta judicial -> bloqueado
      await expect(
        repository.registerAtomicDisembark({
          id_viaje: idViaje,
          id_estudiante: s1,
          resultado_entrega: DisembarkOutcomeType.ENTREGADO_EXITOSO,
          tipo_receptor: ReceptorType.ADULTO_AUTORIZADO,
          receptor_documento_blind_index: judicialBlind,
          id_receptor: null,
          metodo_validacion: "VERIFICACION_VISUAL_PARADA",
          coordenadas: PEREIRA_HOME,
          registrado_por_usuario: idMonitoraUsuario,
          foto_evidencia_url: null,
          observaciones_fallido: null,
          idempotency_key: null,
          sincronizado_offline: false,
        }),
      ).rejects.toThrow(JudicialAlertBlockedError);

      // 4. Autorizado vigente -> aprobado y decrementa aforo 2 -> 1
      const okS1 = await repository.registerAtomicDisembark({
        id_viaje: idViaje,
        id_estudiante: s1,
        resultado_entrega: DisembarkOutcomeType.ENTREGADO_EXITOSO,
        tipo_receptor: ReceptorType.ADULTO_AUTORIZADO,
        receptor_documento_blind_index: validBlind,
        id_receptor: null,
        metodo_validacion: "VERIFICACION_VISUAL_PARADA",
        coordenadas: PEREIRA_HOME,
        registrado_por_usuario: idMonitoraUsuario,
        foto_evidencia_url: null,
        observaciones_fallido: null,
        idempotency_key: `pg-dis-ok-${tag}`,
        sincronizado_offline: false,
      });
      expect(okS1.aprobado).toBe(true);
      expect(okS1.total_a_bordo).toBe(1);
      expect(okS1.estado_custodia).toBe(FsmCustodyState.ENTREGADO_ACUDIENTE);

      // 5. s2 no entregado -> DESEMBARQUE_FALLIDO_RETORNO (sin decremento: sigue en 1)
      const failS2 = await repository.registerAtomicDisembark({
        id_viaje: idViaje,
        id_estudiante: s2,
        resultado_entrega: DisembarkOutcomeType.DESEMBARQUE_FALLIDO_RETORNO,
        tipo_receptor: null,
        receptor_documento_blind_index: null,
        id_receptor: null,
        metodo_validacion: "VERIFICACION_VISUAL_PARADA",
        coordenadas: PEREIRA_HOME,
        registrado_por_usuario: idMonitoraUsuario,
        foto_evidencia_url: null,
        observaciones_fallido: "Ningún adulto autorizado compareció.",
        idempotency_key: `pg-dis-fail-${tag}`,
        sincronizado_offline: false,
      });
      expect(failS2.aprobado).toBe(false);
      expect(failS2.codigo).toBe(
        DisembarkResultCode.DESEMBARQUE_FALLIDO_RETORNO,
      );
      expect(failS2.estado_custodia).toBe(
        FsmCustodyState.RETORNO_SEDE_POR_FALLA_ENTREGA,
      );
      expect(failS2.total_a_bordo).toBe(1);
      expect(failS2.id_incidente).toBeTruthy();

      // Trigger SQL bloquea cierre mientras s2 está en RETORNO_SEDE_POR_FALLA_ENTREGA
      await expect(custodyRepository.finalizeTrip(idViaje)).rejects.toThrow(
        TripClosureBlockedError,
      );

      // 6. Cierre formal en sede -> decrementa 1 -> 0, crea acta_custodia y estado EN_COLEGIO
      const schoolFinal = await repository.finalizeSchoolCustody({
        id_viaje: idViaje,
        id_estudiante: s2,
        recibido_por_coordinador: idCoordinador,
        coordenadas: SAN_BENITO,
        registrado_por_usuario: idCoordinadorUsuario,
        observaciones: "Recibido por Coordinación de Convivencia.",
        idempotency_key: `pg-sede-final-${tag}`,
      });
      expect(schoolFinal.finalizado).toBe(true);
      expect(schoolFinal.total_a_bordo).toBe(0);
      expect(schoolFinal.estado_custodia).toBe(FsmCustodyState.EN_COLEGIO);
      expect(schoolFinal.firma_digital_hash).toMatch(/^[a-f0-9]{64}$/);

      // Ahora el viaje puede finalizarse y la cadena WORM SHA-256 es íntegra
      const closed = await custodyRepository.finalizeTrip(idViaje);
      expect(closed.estado).toBe(TripStateEnum.FINALIZADO);

      const integrity = await custodyRepository.verifyHistoryIntegrity(10000);
      expect(integrity.cadena_integra).toBe(true);
    });
  },
);
