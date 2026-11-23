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
}
