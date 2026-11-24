import { Injectable, OnModuleDestroy } from "@nestjs/common";
import type { Pool, PoolConfig } from "pg";
import { FsmCustodyState } from "../../custody/domain/custody.types";
import { IAttendanceRepository } from "../domain/attendance-repository.port";
import {
  AtomicBoardingCommand,
  AtomicBoardingRecord,
  BoardingResultCode,
  BoardingValidationMethod,
  CreateOperationalIncidentInput,
  IncidentSeverity,
  InvalidAttendanceCoordinatesError,
  InvalidQrTokenError,
  OperationalIncidentRecord,
  StudentNotAssignedToRouteError,
  TripNotFoundError,
  TripNotInProgressError,
  TripOccupancySummary,
} from "../domain/attendance.types";
import {
  ActiveJudicialAlertRecord,
  AtomicDisembarkCommand,
  AtomicDisembarkRecord,
  AuthorizationExpiredError,
  AuthorizedAdultsLimitExceededError,
  CoordinatorUnauthorizedError,
  CustodyActaRecord,
  DeliveryRecord,
  DisembarkOutcomeType,
  DisembarkResultCode,
  DuplicateDisembarkError,
  FailedDeliveryRecordNotFoundError,
  FinalizeSchoolCustodyCommand,
  FinalizeSchoolCustodyRecord,
  IncompatibleTripDirectionError,
  JudicialAlertBlockedError,
  ReceptorInactiveOrRevokedError,
  ReceptorUnauthorizedError,
  SchoolCoordinatorRecord,
  SchoolCustodyAlreadyFinalizedError,
  StoredEntregaReceptorType,
  StudentAuthorizedAdultLink,
  StudentGuardianLink,
  StudentNotFoundError,
  StudentNotInSchoolReturnError,
  StudentNotOnBoardError,
  StudentReceptorDirectory,
} from "../domain/disembark.types";

interface PgErrorLike {
  code?: string;
  message?: string;
  constraint?: string;
}

interface AtomicBoardingRow {
  aprobado: boolean;
  codigo: BoardingResultCode;
  mensaje: string;
  id_viaje: string;
  id_ruta: string;
  id_estudiante: string;
  id_asistencia: string | null;
  id_incidente: string | null;
  id_acudiente_titular: string | null;
  id_notificacion: string | null;
  estado_custodia: FsmCustodyState;
  metodo_validacion: BoardingValidationMethod;
  total_a_bordo: number;
  capacidad_nominal: number;
  duplicado_por_idempotencia: boolean;
  fecha_hora: Date;
}

interface IncidentRow {
  id_incidente: string;
  id_viaje: string;
  id_estudiante: string | null;
  tipo_incidente: string;
  severidad: IncidentSeverity;
  descripcion: string;
  latitud: number | null;
  longitud: number | null;
  fecha_hora: Date;
  registrado_por_usuario: string | null;
}

interface TripOccupancyRow {
  id_viaje: string;
  id_ruta: string;
  estado: string;
  total_a_bordo: number;
  capacidad_nominal: number;
}

interface AtomicDisembarkRow {
  aprobado: boolean;
  codigo:
    | DisembarkResultCode.DESCENSO_EXITOSO
    | DisembarkResultCode.DESEMBARQUE_FALLIDO_RETORNO;
  mensaje: string;
  id_viaje: string;
  id_ruta: string;
  id_estudiante: string;
  id_entrega: string;
  id_asistencia: string | null;
  id_incidente: string | null;
  tipo_receptor: StoredEntregaReceptorType;
  id_acudiente_receptor: string | null;
  id_autorizado_receptor: string | null;
  estado_entrega: DisembarkOutcomeType;
  estado_custodia: FsmCustodyState;
  metodo_validacion: BoardingValidationMethod;
  total_a_bordo: number;
  capacidad_nominal: number;
  id_acudientes_notificados: string[] | null;
  id_notificacion_principal: string | null;
  duplicado_por_idempotencia: boolean;
  fecha_hora: Date;
}

interface FinalizeSchoolCustodyRow {
  finalizado: boolean;
  codigo: DisembarkResultCode.CUSTODIA_SEDE_FINALIZADA;
  mensaje: string;
  id_viaje: string;
  id_ruta: string;
  id_estudiante: string;
  id_entrega: string;
  id_acta: string;
  id_asistencia: string;
  recibido_por_coordinador: string;
  firma_digital_hash: string;
  estado_custodia: FsmCustodyState;
  total_a_bordo: number;
  capacidad_nominal: number;
  id_acudientes_notificados: string[] | null;
  id_notificacion_principal: string | null;
  fecha_recepcion: Date;
}

interface DeliveryRow {
  id_entrega: string;
  id_viaje: string;
  id_estudiante: string;
  intento_secuencia: number;
  tipo_receptor: StoredEntregaReceptorType;
  id_acudiente: string | null;
  id_autorizado: string | null;
  estado_entrega: DisembarkOutcomeType;
  foto_evidencia_url: string | null;
  latitud: number;
  longitud: number;
  observaciones_fallido: string | null;
  idempotency_key: string | null;
  fecha_hora: Date;
}

/**
 * Adaptador PostgreSQL 16 + PostGIS 3.4 para abordaje QR atómico (Issue #8).
 *
 * Invoca transaccionalmente la función almacenada `public.fn_registrar_abordaje_atomico` (V015),
 * garantizando serialización pesimista con `FOR UPDATE`, incremento condicional
 * `total_a_bordo < capacidad_nominal`, restricción única anti-doble abordaje,
 * inserción atómica de incidentes y sincronización WORM con `fn_registrar_transicion_custodia` (V014).
 */
@Injectable()
export class PostgresAttendanceRepository
  implements IAttendanceRepository, OnModuleDestroy
{
  private readonly ownsPool: boolean;

  constructor(
    private readonly pool: Pool,
    ownsPool = false,
  ) {
    this.ownsPool = ownsPool;
  }

  static fromConfig(config: PoolConfig): PostgresAttendanceRepository {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Pool: PgPool } = require("pg") as typeof import("pg");
    return new PostgresAttendanceRepository(new PgPool(config), true);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  async registerAtomicBoarding(
    command: AtomicBoardingCommand,
  ): Promise<AtomicBoardingRecord> {
    try {
      const { rows } = await this.pool.query<AtomicBoardingRow>(
        `SELECT
           aprobado,
           codigo,
           mensaje,
           id_viaje,
           id_ruta,
           id_estudiante,
           id_asistencia,
           id_incidente,
           id_acudiente_titular,
           id_notificacion,
           estado_custodia,
           metodo_validacion,
           total_a_bordo,
           capacidad_nominal,
           duplicado_por_idempotencia,
           fecha_hora
         FROM public.fn_registrar_abordaje_atomico(
           $1::uuid,
           $2::uuid,
           $3::varchar,
           $4::varchar,
           $5::double precision,
           $6::double precision,
           $7::uuid,
           $8::varchar,
           $9::boolean
         )`,
        [
          command.id_viaje,
          command.id_estudiante,
          command.qr_token_hash,
          command.metodo_validacion,
          command.coordenadas.latitud,
          command.coordenadas.longitud,
          command.registrado_por_usuario,
          command.idempotency_key,
          command.sincronizado_offline,
        ],
      );

      const row = rows[0];
      if (!row) {
        throw new TripNotFoundError(command.id_viaje);
      }

      return {
        aprobado: row.aprobado,
        codigo: row.codigo,
        mensaje: row.mensaje,
        id_viaje: row.id_viaje,
        id_ruta: row.id_ruta,
        id_estudiante: row.id_estudiante,
        id_asistencia: row.id_asistencia,
        id_incidente: row.id_incidente,
        id_acudiente_titular: row.id_acudiente_titular,
        id_notificacion: row.id_notificacion,
        estado_custodia: row.estado_custodia,
        metodo_validacion: row.metodo_validacion,
        total_a_bordo: Number(row.total_a_bordo),
        capacidad_nominal: Number(row.capacidad_nominal),
        duplicado_por_idempotencia: Boolean(row.duplicado_por_idempotencia),
        fecha_hora: new Date(row.fecha_hora),
      };
    } catch (error) {
      this.rethrowPgError(error, command);
    }
  }

  async recordIncident(
    input: CreateOperationalIncidentInput,
  ): Promise<OperationalIncidentRecord> {
    const hasCoords =
      input.coordenadas !== null && input.coordenadas !== undefined;

    const { rows } = await this.pool.query<IncidentRow>(
      `INSERT INTO public.incidente (
         id_viaje,
         id_estudiante,
         tipo_incidente,
         severidad,
         descripcion,
         coordenada,
         registrado_por_usuario
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         $3::varchar,
         $4::varchar,
         $5::text,
         CASE
           WHEN $6::double precision IS NOT NULL AND $7::double precision IS NOT NULL
           THEN ST_SetSRID(ST_MakePoint($7::double precision, $6::double precision), 4326)::geography
           ELSE NULL
         END,
         $8::uuid
       )
       RETURNING
         id_incidente,
         id_viaje,
         id_estudiante,
         tipo_incidente,
         severidad,
         descripcion,
         CASE WHEN coordenada IS NOT NULL THEN ST_Y(coordenada::geometry)::double precision ELSE NULL END AS latitud,
         CASE WHEN coordenada IS NOT NULL THEN ST_X(coordenada::geometry)::double precision ELSE NULL END AS longitud,
         fecha_hora,
         registrado_por_usuario`,
      [
        input.id_viaje,
        input.id_estudiante,
        input.tipo_incidente,
        input.severidad,
        input.descripcion,
        hasCoords ? input.coordenadas!.latitud : null,
        hasCoords ? input.coordenadas!.longitud : null,
        input.registrado_por_usuario ?? null,
      ],
    );

    return this.mapIncidentRow(rows[0]);
  }

  async listTripIncidents(
    idViaje: string,
  ): Promise<OperationalIncidentRecord[]> {
    const { rows } = await this.pool.query<IncidentRow>(
      `SELECT
         id_incidente,
         id_viaje,
         id_estudiante,
         tipo_incidente,
         severidad,
         descripcion,
         CASE WHEN coordenada IS NOT NULL THEN ST_Y(coordenada::geometry)::double precision ELSE NULL END AS latitud,
         CASE WHEN coordenada IS NOT NULL THEN ST_X(coordenada::geometry)::double precision ELSE NULL END AS longitud,
         fecha_hora,
         registrado_por_usuario
       FROM public.incidente
       WHERE id_viaje = $1::uuid
       ORDER BY fecha_hora DESC`,
      [idViaje],
    );

    return rows.map((row) => this.mapIncidentRow(row));
  }

  async getTripOccupancy(
    idViaje: string,
  ): Promise<TripOccupancySummary | null> {
    const { rows } = await this.pool.query<TripOccupancyRow>(
      `SELECT
         v.id_viaje,
         v.id_ruta,
         v.estado,
         v.total_a_bordo,
         veh.capacidad_nominal
       FROM public.viaje v
       JOIN public.vehiculo veh ON veh.id_vehiculo = v.id_vehiculo
       WHERE v.id_viaje = $1::uuid`,
      [idViaje],
    );

    if (!rows[0]) {
      return null;
    }

    return {
      id_viaje: rows[0].id_viaje,
      id_ruta: rows[0].id_ruta,
      estado: rows[0].estado,
      total_a_bordo: Number(rows[0].total_a_bordo),
      capacidad_nominal: Number(rows[0].capacidad_nominal),
    };
  }

  async getTripDirection(idViaje: string): Promise<"MANANA" | "TARDE" | null> {
    const { rows } = await this.pool.query<{ jornada: string }>(
      `SELECT r.jornada
       FROM public.viaje v
       JOIN public.ruta r ON r.id_ruta = v.id_ruta
       WHERE v.id_viaje = $1::uuid`,
      [idViaje],
    );

    if (!rows[0]) {
      return null;
    }

    return rows[0].jornada === "TARDE" ? "TARDE" : "MANANA";
  }

  async getStudentReceptorDirectory(
    idEstudiante: string,
  ): Promise<StudentReceptorDirectory | null> {
    const studentRes = await this.pool.query<{
      id_estudiante: string;
      id_colegio: string;
      activo: boolean;
    }>(
      `SELECT id_estudiante, id_colegio, activo
       FROM public.estudiante
       WHERE id_estudiante = $1::uuid`,
      [idEstudiante],
    );

    if (!studentRes.rows[0]) {
      return null;
    }

    const [guardiansRes, authorizedRes, alertsRes] = await Promise.all([
      this.pool.query<StudentGuardianLink>(
        `SELECT
           a.id_acudiente,
           ea.id_estudiante,
           a.nombres,
           a.apellidos,
           a.documento_blind_index,
           ea.parentesco,
           ea.es_tutor_principal,
           ea.orden_notificacion
         FROM public.estudiante_acudiente ea
         JOIN public.acudiente a ON a.id_acudiente = ea.id_acudiente
         WHERE ea.id_estudiante = $1::uuid
         ORDER BY ea.es_tutor_principal DESC, ea.orden_notificacion ASC`,
        [idEstudiante],
      ),
      this.pool.query<{
        id_autorizado: string;
        id_estudiante: string;
        nombres: string;
        apellidos: string;
        documento_blind_index: string;
        parentesco: string;
        prioridad_retiro: number;
        adulto_activo: boolean;
        autorizacion_activa: boolean;
        autorizado_hasta: Date | null;
        expediente_revocado: boolean;
      }>(
        `SELECT
           aa.id_autorizado,
           ea.id_estudiante,
           aa.nombres,
           aa.apellidos,
           aa.documento_blind_index,
           ea.parentesco,
           ea.prioridad_retiro,
           aa.activo AS adulto_activo,
           ea.activo AS autorizacion_activa,
           ea.autorizado_hasta,
           COALESCE(ec.revocado, FALSE) AS expediente_revocado
         FROM public.estudiante_autorizado ea
         JOIN public.adulto_autorizado aa ON aa.id_autorizado = ea.id_autorizado
         LEFT JOIN public.expediente_cifrado ec ON ec.id_autorizado = aa.id_autorizado
         WHERE ea.id_estudiante = $1::uuid
         ORDER BY ea.prioridad_retiro ASC`,
        [idEstudiante],
      ),
      this.pool.query<ActiveJudicialAlertRecord>(
        `SELECT
           id_alerta,
           id_estudiante,
           radicado_medida,
           individuo_blind_index,
           activa,
           eliminado_soft
         FROM public.alerta_judicial
         WHERE id_estudiante = $1::uuid
           AND activa = TRUE
           AND eliminado_soft = FALSE`,
        [idEstudiante],
      ),
    ]);

    return {
      id_estudiante: studentRes.rows[0].id_estudiante,
      id_colegio: studentRes.rows[0].id_colegio,
      activo: studentRes.rows[0].activo,
      acudientes: guardiansRes.rows,
      autorizados: authorizedRes.rows.map((row) => ({
        ...row,
        prioridad_retiro: Number(row.prioridad_retiro),
        autorizado_hasta: row.autorizado_hasta
          ? new Date(row.autorizado_hasta)
          : null,
      })),
      alertas_judiciales: alertsRes.rows,
    };
  }

  async getSchoolCoordinator(
    idCoordinador: string,
  ): Promise<SchoolCoordinatorRecord | null> {
    const { rows } = await this.pool.query<SchoolCoordinatorRecord>(
      `SELECT id_coordinador, id_colegio, nombres, apellidos, cargo
       FROM public.coordinador
       WHERE id_coordinador = $1::uuid`,
      [idCoordinador],
    );
    return rows[0] ?? null;
  }

  async registerAtomicDisembark(
    command: AtomicDisembarkCommand,
  ): Promise<AtomicDisembarkRecord> {
    try {
      const { rows } = await this.pool.query<AtomicDisembarkRow>(
        `SELECT
           aprobado,
           codigo,
           mensaje,
           id_viaje,
           id_ruta,
           id_estudiante,
           id_entrega,
           id_asistencia,
           id_incidente,
           tipo_receptor,
           id_acudiente_receptor,
           id_autorizado_receptor,
           estado_entrega,
           estado_custodia,
           metodo_validacion,
           total_a_bordo,
           capacidad_nominal,
           id_acudientes_notificados,
           id_notificacion_principal,
           duplicado_por_idempotencia,
           fecha_hora
         FROM public.fn_registrar_descenso_atomico(
           $1::uuid,
           $2::uuid,
           $3::varchar,
           $4::varchar,
           $5::varchar,
           $6::uuid,
           $7::varchar,
           $8::double precision,
           $9::double precision,
           $10::uuid,
           $11::text,
           $12::text,
           $13::varchar,
           $14::boolean
         )`,
        [
          command.id_viaje,
          command.id_estudiante,
          command.resultado_entrega,
          command.tipo_receptor,
          command.receptor_documento_blind_index,
          command.id_receptor,
          command.metodo_validacion,
          command.coordenadas.latitud,
          command.coordenadas.longitud,
          command.registrado_por_usuario,
          command.foto_evidencia_url,
          command.observaciones_fallido,
          command.idempotency_key,
          command.sincronizado_offline,
        ],
      );

      const row = rows[0];
      if (!row) {
        throw new TripNotFoundError(command.id_viaje);
      }

      return {
        aprobado: row.aprobado,
        codigo: row.codigo,
        mensaje: row.mensaje,
        id_viaje: row.id_viaje,
        id_ruta: row.id_ruta,
        id_estudiante: row.id_estudiante,
        id_entrega: row.id_entrega,
        id_asistencia: row.id_asistencia,
        id_incidente: row.id_incidente,
        tipo_receptor: row.tipo_receptor,
        id_acudiente_receptor: row.id_acudiente_receptor,
        id_autorizado_receptor: row.id_autorizado_receptor,
        estado_entrega: row.estado_entrega,
        estado_custodia: row.estado_custodia,
        metodo_validacion: row.metodo_validacion,
        total_a_bordo: Number(row.total_a_bordo),
        capacidad_nominal: Number(row.capacidad_nominal),
        id_acudientes_notificados: row.id_acudientes_notificados ?? [],
        id_notificacion_principal: row.id_notificacion_principal,
        duplicado_por_idempotencia: Boolean(row.duplicado_por_idempotencia),
        fecha_hora: new Date(row.fecha_hora),
      };
    } catch (error) {
      this.rethrowDisembarkPgError(error, {
        idViaje: command.id_viaje,
        idEstudiante: command.id_estudiante,
      });
    }
  }

  async finalizeSchoolCustody(
    command: FinalizeSchoolCustodyCommand,
  ): Promise<FinalizeSchoolCustodyRecord> {
    try {
      const { rows } = await this.pool.query<FinalizeSchoolCustodyRow>(
        `SELECT
           finalizado,
           codigo,
           mensaje,
           id_viaje,
           id_ruta,
           id_estudiante,
           id_entrega,
           id_acta,
           id_asistencia,
           recibido_por_coordinador,
           firma_digital_hash,
           estado_custodia,
           total_a_bordo,
           capacidad_nominal,
           id_acudientes_notificados,
           id_notificacion_principal,
           fecha_recepcion
         FROM public.fn_finalizar_custodia_sede_atomico(
           $1::uuid,
           $2::uuid,
           $3::uuid,
           $4::double precision,
           $5::double precision,
           $6::uuid,
           $7::text,
           $8::varchar
         )`,
        [
          command.id_viaje,
          command.id_estudiante,
          command.recibido_por_coordinador,
          command.coordenadas.latitud,
          command.coordenadas.longitud,
          command.registrado_por_usuario,
          command.observaciones,
          command.idempotency_key,
        ],
      );

      const row = rows[0];
      if (!row) {
        throw new TripNotFoundError(command.id_viaje);
      }

      return {
        finalizado: row.finalizado,
        codigo: row.codigo,
        mensaje: row.mensaje,
        id_viaje: row.id_viaje,
        id_ruta: row.id_ruta,
        id_estudiante: row.id_estudiante,
        id_entrega: row.id_entrega,
        id_acta: row.id_acta,
        id_asistencia: row.id_asistencia,
        recibido_por_coordinador: row.recibido_por_coordinador,
        firma_digital_hash: row.firma_digital_hash,
        estado_custodia: row.estado_custodia,
        total_a_bordo: Number(row.total_a_bordo),
        capacidad_nominal: Number(row.capacidad_nominal),
        id_acudientes_notificados: row.id_acudientes_notificados ?? [],
        id_notificacion_principal: row.id_notificacion_principal,
        fecha_recepcion: new Date(row.fecha_recepcion),
      };
    } catch (error) {
      this.rethrowDisembarkPgError(error, {
        idViaje: command.id_viaje,
        idEstudiante: command.id_estudiante,
        idCoordinador: command.recibido_por_coordinador,
      });
    }
  }

  async listStudentDeliveries(
    idViaje: string,
    idEstudiante?: string,
  ): Promise<DeliveryRecord[]> {
    const params: unknown[] = [idViaje];
    const studentFilter = idEstudiante ? "AND id_estudiante = $2::uuid" : "";
    if (idEstudiante) {
      params.push(idEstudiante);
    }

    const { rows } = await this.pool.query<DeliveryRow>(
      `SELECT
         id_entrega,
         id_viaje,
         id_estudiante,
         intento_secuencia,
         tipo_receptor,
         id_acudiente,
         id_autorizado,
         estado_entrega,
         foto_evidencia_url,
         ST_Y(coordenada::geometry)::double precision AS latitud,
         ST_X(coordenada::geometry)::double precision AS longitud,
         observaciones_fallido,
         idempotency_key,
         fecha_hora
       FROM public.entrega
       WHERE id_viaje = $1::uuid ${studentFilter}
       ORDER BY fecha_hora ASC, intento_secuencia ASC`,
      params,
    );

    return rows.map((row) => ({
      id_entrega: row.id_entrega,
      id_viaje: row.id_viaje,
      id_estudiante: row.id_estudiante,
      intento_secuencia: Number(row.intento_secuencia),
      tipo_receptor: row.tipo_receptor,
      id_acudiente: row.id_acudiente,
      id_autorizado: row.id_autorizado,
      estado_entrega: row.estado_entrega,
      foto_evidencia_url: row.foto_evidencia_url,
      coordenadas: {
        latitud: Number(row.latitud),
        longitud: Number(row.longitud),
      },
      observaciones_fallido: row.observaciones_fallido,
      idempotency_key: row.idempotency_key,
      fecha_hora: new Date(row.fecha_hora),
    }));
  }

  async getCustodyActaByDelivery(
    idEntrega: string,
  ): Promise<CustodyActaRecord | null> {
    const { rows } = await this.pool.query<CustodyActaRecord>(
      `SELECT
         id_acta,
         id_entrega,
         id_estudiante,
         recibido_por_coordinador,
         fecha_recepcion,
         firma_digital_hash,
         observaciones
       FROM public.acta_custodia
       WHERE id_entrega = $1::uuid`,
      [idEntrega],
    );

    if (!rows[0]) {
      return null;
    }

    return {
      ...rows[0],
      fecha_recepcion: new Date(rows[0].fecha_recepcion),
    };
  }

  private mapIncidentRow(row: IncidentRow): OperationalIncidentRecord {
    return {
      id_incidente: row.id_incidente,
      id_viaje: row.id_viaje,
      id_estudiante: row.id_estudiante,
      tipo_incidente: row.tipo_incidente,
      severidad: row.severidad,
      descripcion: row.descripcion,
      coordenadas:
        row.latitud != null && row.longitud != null
          ? { latitud: Number(row.latitud), longitud: Number(row.longitud) }
          : null,
      fecha_hora: new Date(row.fecha_hora),
      registrado_por_usuario: row.registrado_por_usuario,
    };
  }

  private rethrowPgError(
    error: unknown,
    command: AtomicBoardingCommand,
  ): never {
    const pgErr = error as PgErrorLike;
    const message = pgErr?.message ?? "";

    if (pgErr?.code === "P0002") {
      if (message.includes("VIAJE_NO_ENCONTRADO")) {
        throw new TripNotFoundError(command.id_viaje);
      }
      if (message.includes("QR_INVALIDO")) {
        throw new InvalidQrTokenError("QR_INVALIDO", message);
      }
    }

    if (pgErr?.code === "22023") {
      if (message.includes("QR_INVALIDO")) {
        throw new InvalidQrTokenError("QR_INVALIDO", message);
      }
      throw new InvalidAttendanceCoordinatesError(
        message || "Parámetros de abordaje o coordenadas WGS84 inválidos.",
      );
    }

    if (pgErr?.code === "23514") {
      if (message.includes("VIAJE_NO_EN_CURSO")) {
        const stateMatch = message.match(/en estado ([A-Z_]+)/);
        throw new TripNotInProgressError(
          command.id_viaje,
          stateMatch?.[1] ?? "DESCONOCIDO",
        );
      }
      if (message.includes("ESTUDIANTE_NO_ASIGNADO_RUTA")) {
        throw new StudentNotAssignedToRouteError(
          command.id_estudiante ?? "DESCONOCIDO",
          command.id_viaje,
        );
      }
    }

    throw error;
  }

  private rethrowDisembarkPgError(
    error: unknown,
    context: {
      idViaje: string;
      idEstudiante: string;
      idCoordinador?: string;
    },
  ): never {
    const pgErr = error as PgErrorLike;
    const message = pgErr?.message ?? "";

    if (pgErr?.code === "P0002") {
      if (message.includes("VIAJE_NO_ENCONTRADO")) {
        throw new TripNotFoundError(context.idViaje);
      }
      if (message.includes("ESTUDIANTE_NO_ENCONTRADO")) {
        throw new StudentNotFoundError(context.idEstudiante);
      }
      if (message.includes("ENTREGA_FALLIDA_NO_ENCONTRADA")) {
        throw new FailedDeliveryRecordNotFoundError(
          context.idViaje,
          context.idEstudiante,
        );
      }
    }

    if (pgErr?.code === "42501") {
      if (message.includes("ALERTA_JUDICIAL_ACTIVA")) {
        throw new JudicialAlertBlockedError(context.idEstudiante);
      }
      if (message.includes("AUTORIZACION_VENCIDA")) {
        throw new AuthorizationExpiredError(context.idEstudiante, new Date());
      }
      if (message.includes("RECEPTOR_INACTIVO_O_REVOCADO")) {
        throw new ReceptorInactiveOrRevokedError(context.idEstudiante);
      }
      if (message.includes("COORDINADOR_NO_AUTORIZADO")) {
        throw new CoordinatorUnauthorizedError(
          context.idCoordinador ?? "DESCONOCIDO",
          context.idEstudiante,
        );
      }
      if (message.includes("RECEPTOR_NO_AUTORIZADO")) {
        throw new ReceptorUnauthorizedError(context.idEstudiante, message);
      }
    }

    if (pgErr?.code === "23505") {
      if (message.includes("ACTA_CUSTODIA_EXISTENTE")) {
        throw new SchoolCustodyAlreadyFinalizedError(context.idEstudiante);
      }
      if (message.includes("DESCENSO_PREVIO_EXISTE")) {
        throw new DuplicateDisembarkError(
          context.idViaje,
          context.idEstudiante,
        );
      }
    }

    if (pgErr?.code === "22023") {
      throw new InvalidAttendanceCoordinatesError(
        message || "Parámetros de desembarque o coordenadas WGS84 inválidos.",
      );
    }

    if (pgErr?.code === "23514") {
      if (message.includes("VIAJE_NO_EN_CURSO")) {
        const stateMatch = message.match(/en estado ([A-Z_]+)/);
        throw new TripNotInProgressError(
          context.idViaje,
          stateMatch?.[1] ?? "DESCONOCIDO",
        );
      }
      if (message.includes("ESTUDIANTE_NO_A_BORDO")) {
        throw new StudentNotOnBoardError(
          context.idEstudiante,
          context.idViaje,
          "NO_A_BORDO",
        );
      }
      if (message.includes("ESTUDIANTE_NO_EN_RETORNO_SEDE")) {
        throw new StudentNotInSchoolReturnError(
          context.idEstudiante,
          context.idViaje,
          "OTRO_ESTADO",
        );
      }
      if (message.includes("RECORRIDO_INCOMPATIBLE_DESCENSO")) {
        throw new IncompatibleTripDirectionError(message);
      }
      if (message.includes("LIMITE_AUTORIZADOS_EXCEDIDO")) {
        throw new AuthorizedAdultsLimitExceededError(context.idEstudiante, 4);
      }
    }

    throw error;
  }
}
