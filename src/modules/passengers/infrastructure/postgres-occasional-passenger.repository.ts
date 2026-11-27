import { Injectable, OnModuleDestroy } from "@nestjs/common";
import type { Pool, PoolConfig } from "pg";
import { FsmCustodyState } from "../../custody/domain/custody.types";
import { IOccasionalPassengerRepository } from "../domain/occasional-passenger-repository.port";
import {
  AbsenceIrreversibleError,
  ApproveOccasionalSeatCommand,
  ApproveOccasionalSeatResult,
  CoordinatorNotAuthorizedForTripError,
  DuplicateOccasionalRequestError,
  GuardianNotAuthorizedForStudentError,
  OccasionalBookingRulesViolationError,
  OccasionalPassengerRecord,
  OccasionalRejectionReason,
  OccasionalRequestInvalidStateError,
  OccasionalRequestNotFoundError,
  OccasionalRequestStatus,
  OccasionalStudentNotFoundError,
  OccasionalTripNotFoundError,
  OccasionalTripNotScheduledError,
  RequestOccasionalSeatCommand,
  RequestOccasionalSeatResult,
  StudentAlreadyAssignedToRouteError,
  TripManifestEntry,
  VacancyBalanceSnapshot,
} from "../domain/occasional-passenger.types";

interface PgErrorLike {
  code?: string;
  message?: string;
  constraint?: string;
}

interface VacancyBalanceRow {
  id_viaje: string;
  id_ruta: string;
  estado_viaje: string;
  hora_inicio_programada: Date;
  capacidad_nominal: number;
  estudiantes_asignados: number;
  inasistencias_reportadas: number;
  ocasionales_activos: number;
  ocupacion_proyectada: number;
  inasistencias_disponibles: number;
  cupo_nominal_disponible: number;
  vacantes_netas: number;
}

interface RequestSeatRow {
  id_pasajero_ocasional: string;
  id_estudiante: string;
  id_viaje: string;
  id_ruta: string;
  id_estudiante_que_libera_cupo: string;
  qr_provisional_hash: string;
  estado_solicitud: OccasionalRequestStatus;
  solicitado_en: Date;
  solicitado_por_acudiente: string | null;
  motivo: string | null;
  hora_inicio_programada: Date;
  capacidad_nominal: number;
  estudiantes_asignados: number;
  inasistencias_reportadas: number;
  ocasionales_activos: number;
  ocupacion_proyectada: number;
  vacantes_netas_restantes: number;
}

interface ApproveSeatRow {
  id_pasajero_ocasional: string;
  id_estudiante: string;
  id_viaje: string;
  id_ruta: string;
  id_estudiante_que_libera_cupo: string;
  qr_provisional_hash: string;
  estado_solicitud: OccasionalRequestStatus;
  solicitado_en: Date;
  aprobado_en: Date;
  aprobado_por_coordinador: string;
  estado_custodia: FsmCustodyState;
  es_pasajero_ocasional: boolean;
  capacidad_nominal: number;
  estudiantes_asignados: number;
  inasistencias_reportadas: number;
  ocasionales_activos: number;
  ocupacion_proyectada: number;
  vacantes_netas_restantes: number;
}

interface OccasionalRequestRow {
  id_pasajero_ocasional: string;
  id_estudiante: string;
  id_viaje: string;
  id_ruta: string;
  id_estudiante_que_libera_cupo: string;
  qr_provisional_hash: string;
  estado_solicitud: OccasionalRequestStatus;
  solicitado_en: Date;
  solicitado_por_acudiente: string | null;
  motivo: string | null;
  aprobado_en: Date | null;
  aprobado_por_coordinador: string | null;
}

interface ManifestRow {
  id_viaje: string;
  id_estudiante: string;
  estado_custodia: FsmCustodyState;
  es_pasajero_ocasional: boolean;
}

/**
 * Adaptador PostgreSQL 16 + PostGIS 3.4 para gestión transaccional de pasajeros
 * ocasionales y reasignación atómica de cupos (Issue #11 - V018).
 */
@Injectable()
export class PostgresOccasionalPassengerRepository
  implements IOccasionalPassengerRepository, OnModuleDestroy
{
  constructor(
    private readonly pool: Pool,
    private readonly ownsPool = true,
  ) {}

  static fromConfig(
    config: PoolConfig,
  ): PostgresOccasionalPassengerRepository {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Pool: PgPool } = require("pg") as typeof import("pg");
    return new PostgresOccasionalPassengerRepository(new PgPool(config), true);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  async evaluateTripVacancyBalance(
    idViaje: string,
  ): Promise<VacancyBalanceSnapshot> {
    try {
      const result = await this.pool.query<VacancyBalanceRow>(
        `SELECT * FROM public.fn_evaluar_balance_vacantes_viaje($1::uuid)`,
        [idViaje],
      );
      const row = result.rows[0];
      if (!row) {
        throw new OccasionalTripNotFoundError(idViaje);
      }
      return this.mapBalanceRow(row);
    } catch (error) {
      throw this.translatePgError(error, { idViaje });
    }
  }

  async requestOccasionalSeat(
    command: RequestOccasionalSeatCommand,
  ): Promise<RequestOccasionalSeatResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<RequestSeatRow>(
        `SELECT * FROM public.fn_solicitar_pasajero_ocasional(
           $1::uuid,
           $2::uuid,
           $3::uuid,
           $4::varchar,
           $5::text,
           $6::timestamptz
         )`,
        [
          command.id_viaje,
          command.id_estudiante,
          command.solicitado_por_usuario,
          command.qr_provisional_hash.trim().toLowerCase(),
          command.motivo ?? null,
          command.solicitado_en.toISOString(),
        ],
      );
      await client.query("COMMIT");

      const row = result.rows[0];
      const inasistenciasDisponibles = Math.max(
        0,
        Number(row.inasistencias_reportadas) - Number(row.ocasionales_activos),
      );
      const cupoNominalDisponible = Math.max(
        0,
        Number(row.capacidad_nominal) - Number(row.ocupacion_proyectada),
      );

      return {
        solicitud: {
          id_pasajero_ocasional: row.id_pasajero_ocasional,
          id_estudiante: row.id_estudiante,
          id_viaje: row.id_viaje,
          id_ruta: row.id_ruta,
          id_estudiante_que_libera_cupo: row.id_estudiante_que_libera_cupo,
          qr_provisional_hash: row.qr_provisional_hash,
          estado_solicitud: row.estado_solicitud,
          solicitado_en: new Date(row.solicitado_en),
          solicitado_por_acudiente: row.solicitado_por_acudiente,
          motivo: row.motivo,
          aprobado_en: null,
          aprobado_por_coordinador: null,
        },
        hora_inicio_programada: new Date(row.hora_inicio_programada),
        balance_vacantes: {
          id_viaje: row.id_viaje,
          id_ruta: row.id_ruta,
          estado_viaje: "PROGRAMADO",
          hora_inicio_programada: new Date(row.hora_inicio_programada),
          capacidad_nominal: Number(row.capacidad_nominal),
          estudiantes_asignados: Number(row.estudiantes_asignados),
          inasistencias_reportadas: Number(row.inasistencias_reportadas),
          ocasionales_activos: Number(row.ocasionales_activos),
          ocupacion_proyectada: Number(row.ocupacion_proyectada),
          inasistencias_disponibles: inasistenciasDisponibles,
          cupo_nominal_disponible: cupoNominalDisponible,
          vacantes_netas: Number(row.vacantes_netas_restantes),
        },
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw this.translatePgError(error, {
        idViaje: command.id_viaje,
        idEstudiante: command.id_estudiante,
        idUsuario: command.solicitado_por_usuario,
      });
    } finally {
      client.release();
    }
  }

  async approveOccasionalSeat(
    command: ApproveOccasionalSeatCommand,
  ): Promise<ApproveOccasionalSeatResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ApproveSeatRow>(
        `SELECT * FROM public.fn_aprobar_pasajero_ocasional(
           $1::uuid,
           $2::uuid,
           $3::uuid
         )`,
        [
          command.id_pasajero_ocasional,
          command.aprobado_por_usuario,
          command.id_coordinador ?? null,
        ],
      );
      await client.query("COMMIT");

      const row = result.rows[0];
      const balance = await this.evaluateTripVacancyBalance(row.id_viaje);

      return {
        solicitud: {
          id_pasajero_ocasional: row.id_pasajero_ocasional,
          id_estudiante: row.id_estudiante,
          id_viaje: row.id_viaje,
          id_ruta: row.id_ruta,
          id_estudiante_que_libera_cupo: row.id_estudiante_que_libera_cupo,
          qr_provisional_hash: row.qr_provisional_hash,
          estado_solicitud: row.estado_solicitud,
          solicitado_en: new Date(row.solicitado_en),
          solicitado_por_acudiente: null,
          motivo: null,
          aprobado_en: new Date(row.aprobado_en),
          aprobado_por_coordinador: row.aprobado_por_coordinador,
        },
        lista_asistencia: {
          id_viaje: row.id_viaje,
          id_estudiante: row.id_estudiante,
          estado_custodia: row.estado_custodia,
          es_pasajero_ocasional: Boolean(row.es_pasajero_ocasional),
        },
        balance_vacantes: balance,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw this.translatePgError(error, {
        idSolicitud: command.id_pasajero_ocasional,
        idUsuario: command.aprobado_por_usuario,
      });
    } finally {
      client.release();
    }
  }

  async revertAbsence(idViaje: string, idEstudiante: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM public.inasistencia
         WHERE id_viaje = $1::uuid
           AND id_estudiante = $2::uuid`,
        [idViaje, idEstudiante],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw this.translatePgError(error, { idViaje, idEstudiante });
    } finally {
      client.release();
    }
  }

  async findRequestById(
    idPasajeroOcasional: string,
  ): Promise<OccasionalPassengerRecord | null> {
    const result = await this.pool.query<OccasionalRequestRow>(
      `SELECT
         po.id_pasajero_ocasional,
         po.id_estudiante,
         po.id_viaje,
         v.id_ruta,
         po.id_estudiante_que_libera_cupo,
         po.qr_provisional_hash,
         po.estado_solicitud,
         po.solicitado_en,
         po.solicitado_por_acudiente,
         po.motivo,
         po.aprobado_en,
         po.aprobado_por_coordinador
       FROM public.pasajero_ocasional po
       JOIN public.viaje v ON v.id_viaje = po.id_viaje
       WHERE po.id_pasajero_ocasional = $1::uuid`,
      [idPasajeroOcasional],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      id_pasajero_ocasional: row.id_pasajero_ocasional,
      id_estudiante: row.id_estudiante,
      id_viaje: row.id_viaje,
      id_ruta: row.id_ruta,
      id_estudiante_que_libera_cupo: row.id_estudiante_que_libera_cupo,
      qr_provisional_hash: row.qr_provisional_hash,
      estado_solicitud: row.estado_solicitud,
      solicitado_en: new Date(row.solicitado_en),
      solicitado_por_acudiente: row.solicitado_por_acudiente,
      motivo: row.motivo,
      aprobado_en: row.aprobado_en ? new Date(row.aprobado_en) : null,
      aprobado_por_coordinador: row.aprobado_por_coordinador,
    };
  }

  async listTripPassengerManifest(
    idViaje: string,
  ): Promise<TripManifestEntry[]> {
    const result = await this.pool.query<ManifestRow>(
      `SELECT
         ve.id_viaje,
         ve.id_estudiante,
         ve.estado_custodia,
         ve.es_pasajero_ocasional
       FROM public.viaje_estudiante ve
       WHERE ve.id_viaje = $1::uuid
       ORDER BY ve.actualizado_en ASC`,
      [idViaje],
    );
    return result.rows.map((row) => ({
      id_viaje: row.id_viaje,
      id_estudiante: row.id_estudiante,
      estado_custodia: row.estado_custodia,
      es_pasajero_ocasional: Boolean(row.es_pasajero_ocasional),
    }));
  }

  private mapBalanceRow(row: VacancyBalanceRow): VacancyBalanceSnapshot {
    return {
      id_viaje: row.id_viaje,
      id_ruta: row.id_ruta,
      estado_viaje: row.estado_viaje,
      hora_inicio_programada: new Date(row.hora_inicio_programada),
      capacidad_nominal: Number(row.capacidad_nominal),
      estudiantes_asignados: Number(row.estudiantes_asignados),
      inasistencias_reportadas: Number(row.inasistencias_reportadas),
      ocasionales_activos: Number(row.ocasionales_activos),
      ocupacion_proyectada: Number(row.ocupacion_proyectada),
      inasistencias_disponibles: Number(row.inasistencias_disponibles),
      cupo_nominal_disponible: Number(row.cupo_nominal_disponible),
      vacantes_netas: Number(row.vacantes_netas),
    };
  }

  private translatePgError(
    error: unknown,
    context: {
      idViaje?: string;
      idEstudiante?: string;
      idUsuario?: string;
      idSolicitud?: string;
    },
  ): Error {
    if (error instanceof Error && "code" in error) {
      const pgError = error as PgErrorLike;
      const msg = pgError.message ?? error.message;

      if (msg.includes("VIAJE_NO_ENCONTRADO")) {
        return new OccasionalTripNotFoundError(context.idViaje ?? "desconocido");
      }
      if (msg.includes("VIAJE_NO_PROGRAMADO")) {
        return new OccasionalTripNotScheduledError(
          context.idViaje ?? "desconocido",
          "NO_PROGRAMADO",
        );
      }
      if (msg.includes("ESTUDIANTE_NO_ENCONTRADO")) {
        return new OccasionalStudentNotFoundError(
          context.idEstudiante ?? "desconocido",
        );
      }
      if (msg.includes("ACUDIENTE_NO_AUTORIZADO_PARA_ESTUDIANTE")) {
        return new GuardianNotAuthorizedForStudentError(
          context.idUsuario ?? "desconocido",
          context.idEstudiante ?? "desconocido",
        );
      }
      if (msg.includes("ESTUDIANTE_YA_ASIGNADO_A_RUTA")) {
        return new StudentAlreadyAssignedToRouteError(
          context.idEstudiante ?? "desconocido",
          context.idViaje ?? "desconocido",
        );
      }
      if (
        msg.includes("SOLICITUD_DUPLICADA") ||
        msg.includes("ESTUDIANTE_YA_EN_LISTA_VIAJE") ||
        pgError.constraint === "uq_pasajero_ocasional_estudiante_viaje"
      ) {
        return new DuplicateOccasionalRequestError(
          context.idEstudiante ?? "desconocido",
          context.idViaje ?? "desconocido",
        );
      }
      if (msg.includes("SOLICITUD_NO_ENCONTRADA")) {
        return new OccasionalRequestNotFoundError(
          context.idSolicitud ?? "desconocido",
        );
      }
      if (msg.includes("SOLICITUD_ESTADO_INVALIDO")) {
        return new OccasionalRequestInvalidStateError(
          context.idSolicitud ?? "desconocido",
          "INVALIDO",
        );
      }
      if (msg.includes("COORDINADOR_NO_AUTORIZADO")) {
        return new CoordinatorNotAuthorizedForTripError(
          context.idViaje ?? "desconocido",
        );
      }
      if (msg.includes("INASISTENCIA_IRREVERSIBLE_CUPO_ASIGNADO")) {
        return new AbsenceIrreversibleError(
          context.idEstudiante ?? "desconocido",
          context.idViaje ?? "desconocido",
        );
      }
      if (msg.includes("REGLAS_PASAJERO_OCASIONAL_INCUMPLIDAS")) {
        const motivosMatch = msg.match(
          /REGLAS_PASAJERO_OCASIONAL_INCUMPLIDAS\[([^\]]+)\]/,
        );
        const motivos = (motivosMatch?.[1] ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean) as OccasionalRejectionReason[];
        return new OccasionalBookingRulesViolationError({
          motivos_rechazo:
            motivos.length > 0
              ? motivos
              : [OccasionalRejectionReason.SIN_VACANTE_POR_INASISTENCIA],
          message: msg,
        });
      }
      if (pgError.constraint === "uq_pasajero_ocasional_cupo_liberado") {
        return new OccasionalBookingRulesViolationError({
          motivos_rechazo: [
            OccasionalRejectionReason.SIN_VACANTE_POR_INASISTENCIA,
          ],
          message:
            "El cupo liberado por inasistencia ya fue reservado concurrentemente por otra solicitud.",
        });
      }
    }

    return error instanceof Error ? error : new Error(String(error));
  }
}
