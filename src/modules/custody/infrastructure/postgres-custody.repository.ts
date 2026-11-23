import { Injectable, OnModuleDestroy } from "@nestjs/common";
import type { Pool, PoolConfig } from "pg";
import { TripStateEnum } from "@common/enums/trip-state.enum";
import {
  ICustodyRepository,
  PersistCustodyTransitionInput,
  PersistCustodyTransitionResult,
} from "../domain/custody-repository.port";
import {
  CustodyChainVerificationReport,
  CustodyEnrollmentNotFoundError,
  CustodyHistoryRecord,
  CustodyIntegrityCheckRow,
  CustodyInvariantViolationError,
  FsmCustodyState,
  InvalidCustodyCoordinatesError,
  MorningInitializationSummary,
  StudentTripCustodyRecord,
  TripClosureBlockedError,
  TripCustodyMeta,
  TripDirection,
  WormImmutabilityViolationError,
} from "../domain/custody.types";

interface PgErrorLike {
  code?: string;
  message?: string;
  constraint?: string;
}

interface StudentTripCustodyRow {
  id_viaje: string;
  id_estudiante: string;
  estado_custodia: FsmCustodyState;
  es_pasajero_ocasional: boolean;
  hora_abordaje: Date | null;
  hora_desembarque: Date | null;
  actualizado_en: Date;
}

interface CustodyHistoryRow {
  id_historial: string;
  secuencia: string | number;
  id_estudiante: string;
  id_viaje: string;
  estado_origen: FsmCustodyState;
  estado_destino: FsmCustodyState;
  disparador_evento: string;
  latitud?: number | null;
  longitud?: number | null;
  fecha_hora: Date;
  registrado_por_usuario: string | null;
  hash_sha256_anterior: string;
  hash_sha256_actual: string;
}

interface IntegrityRow {
  p_secuencia: string | number;
  es_valido: boolean;
  hash_esperado: string;
  hash_encontrado: string;
}

interface MorningInitRow {
  id_viaje: string;
  id_estudiante: string;
  estado_custodia: FsmCustodyState;
}

interface TripRow {
  id_viaje: string;
  id_ruta: string;
  fecha: string | Date;
  jornada: string;
  estado: TripStateEnum;
  hora_fin_real: Date | null;
}

/**
 * Adaptador PostgreSQL 16 + PostGIS 3.4 para custodia FSM y ledger WORM (Issue #7).
 *
 * - Invoca la función almacenada `fn_registrar_transicion_custodia` (V014),
 *   que actualiza `viaje_estudiante` e inserta en `historial_estado_custodia`
 *   disparando `trg_encadenar_hash_custodia` (SHA-256 + `pg_advisory_xact_lock`, V006).
 * - Invoca `fn_verificar_integridad_custodia` (V006) y `fn_inicializar_custodia_matutina` (V014).
 * - El cierre de viaje (`FINALIZADO`) está protegido además por el trigger SQL
 *   `trg_bloquear_cierre_viaje_con_menores_a_bordo` (V014).
 */
@Injectable()
export class PostgresCustodyRepository
  implements ICustodyRepository, OnModuleDestroy
{
  private readonly ownsPool: boolean;

  constructor(
    private readonly pool: Pool,
    ownsPool = false,
  ) {
    this.ownsPool = ownsPool;
  }

  static fromConfig(config: PoolConfig): PostgresCustodyRepository {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Pool: PgPool } = require("pg") as typeof import("pg");
    return new PostgresCustodyRepository(new PgPool(config), true);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  async registerTrip(trip: TripCustodyMeta): Promise<TripCustodyMeta> {
    const existing = await this.findTripById(trip.id_viaje);
    if (existing) {
      return existing;
    }
    return { ...trip };
  }

  async findTripById(idViaje: string): Promise<TripCustodyMeta | null> {
    const { rows } = await this.pool.query<TripRow>(
      `SELECT
         v.id_viaje,
         v.id_ruta,
         v.fecha::text AS fecha,
         r.jornada,
         v.estado,
         v.hora_fin_real
       FROM public.viaje v
       JOIN public.ruta r ON r.id_ruta = v.id_ruta
       WHERE v.id_viaje = $1`,
      [idViaje],
    );

    if (!rows[0]) {
      return null;
    }

    return this.mapTrip(rows[0]);
  }

  async enrollStudentInTrip(
    idViaje: string,
    idEstudiante: string,
    initialState: FsmCustodyState = FsmCustodyState.NO_INICIADO,
    esPasajeroOcasional = false,
  ): Promise<StudentTripCustodyRecord> {
    const { rows } = await this.pool.query<StudentTripCustodyRow>(
      `INSERT INTO public.viaje_estudiante (
         id_viaje,
         id_estudiante,
         estado_custodia,
         es_pasajero_ocasional
       )
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id_viaje, id_estudiante) DO UPDATE
         SET actualizado_en = public.viaje_estudiante.actualizado_en
       RETURNING
         id_viaje,
         id_estudiante,
         estado_custodia,
         es_pasajero_ocasional,
         hora_abordaje,
         hora_desembarque,
         actualizado_en`,
      [idViaje, idEstudiante, initialState, esPasajeroOcasional],
    );

    return this.mapCustodyRow(rows[0]);
  }

  async getStudentTripState(
    idViaje: string,
    idEstudiante: string,
  ): Promise<StudentTripCustodyRecord | null> {
    const { rows } = await this.pool.query<StudentTripCustodyRow>(
      `SELECT
         id_viaje,
         id_estudiante,
         estado_custodia,
         es_pasajero_ocasional,
         hora_abordaje,
         hora_desembarque,
         actualizado_en
       FROM public.viaje_estudiante
       WHERE id_viaje = $1 AND id_estudiante = $2`,
      [idViaje, idEstudiante],
    );

    return rows[0] ? this.mapCustodyRow(rows[0]) : null;
  }

  async listTripCustodyStates(
    idViaje: string,
  ): Promise<StudentTripCustodyRecord[]> {
    const { rows } = await this.pool.query<StudentTripCustodyRow>(
      `SELECT
         id_viaje,
         id_estudiante,
         estado_custodia,
         es_pasajero_ocasional,
         hora_abordaje,
         hora_desembarque,
         actualizado_en
       FROM public.viaje_estudiante
       WHERE id_viaje = $1
       ORDER BY actualizado_en DESC, id_estudiante ASC`,
      [idViaje],
    );

    return rows.map((row) => this.mapCustodyRow(row));
  }

  async listStudentsByState(
    idViaje: string,
    state: FsmCustodyState,
  ): Promise<StudentTripCustodyRecord[]> {
    const { rows } = await this.pool.query<StudentTripCustodyRow>(
      `SELECT
         id_viaje,
         id_estudiante,
         estado_custodia,
         es_pasajero_ocasional,
         hora_abordaje,
         hora_desembarque,
         actualizado_en
       FROM public.viaje_estudiante
       WHERE id_viaje = $1 AND estado_custodia = $2
       ORDER BY id_estudiante ASC`,
      [idViaje, state],
    );

    return rows.map((row) => this.mapCustodyRow(row));
  }

  async applyTransitionAndAppendHistory(
    input: PersistCustodyTransitionInput,
  ): Promise<PersistCustodyTransitionResult> {
    try {
      const { rows: historyRows } = await this.pool.query<CustodyHistoryRow>(
        `SELECT
           id_historial,
           secuencia,
           id_estudiante,
           id_viaje,
           estado_origen,
           estado_destino,
           disparador_evento,
           fecha_hora,
           registrado_por_usuario,
           hash_sha256_anterior,
           hash_sha256_actual
         FROM public.fn_registrar_transicion_custodia(
           $1::uuid,
           $2::uuid,
           $3::varchar,
           $4::varchar,
           $5::varchar,
           $6::uuid,
           $7::double precision,
           $8::double precision
         )`,
        [
          input.id_viaje,
          input.id_estudiante,
          input.estado_destino,
          input.tipo_recorrido,
          input.disparador_evento,
          input.registrado_por_usuario ?? null,
          input.coordenadas?.latitud ?? null,
          input.coordenadas?.longitud ?? null,
        ],
      );

      const custody = await this.getStudentTripState(
        input.id_viaje,
        input.id_estudiante,
      );

      if (!custody || !historyRows[0]) {
        throw new CustodyEnrollmentNotFoundError(
          input.id_viaje,
          input.id_estudiante,
        );
      }

      const history = this.mapHistoryRow({
        ...historyRows[0],
        latitud: input.coordenadas?.latitud ?? null,
        longitud: input.coordenadas?.longitud ?? null,
      });

      return { custody, history };
    } catch (error) {
      this.rethrowPgError(error, {
        idViaje: input.id_viaje,
        idEstudiante: input.id_estudiante,
        toState: input.estado_destino,
        tripDirection: input.tipo_recorrido,
      });
    }
  }

  async listHistoryByTrip(idViaje: string): Promise<CustodyHistoryRecord[]> {
    const { rows } = await this.pool.query<CustodyHistoryRow>(
      `SELECT
         id_historial,
         secuencia,
         id_estudiante,
         id_viaje,
         estado_origen,
         estado_destino,
         disparador_evento,
         CASE
           WHEN coordenadas_gps IS NOT NULL THEN ST_Y(coordenadas_gps::geometry)::double precision
           ELSE NULL
         END AS latitud,
         CASE
           WHEN coordenadas_gps IS NOT NULL THEN ST_X(coordenadas_gps::geometry)::double precision
           ELSE NULL
         END AS longitud,
         fecha_hora,
         registrado_por_usuario,
         hash_sha256_anterior,
         hash_sha256_actual
       FROM public.historial_estado_custodia
       WHERE id_viaje = $1
       ORDER BY secuencia ASC`,
      [idViaje],
    );

    return rows.map((row) => this.mapHistoryRow(row));
  }

  async listHistoryByStudent(
    idEstudiante: string,
    limit = 100,
  ): Promise<CustodyHistoryRecord[]> {
    const safeLimit = Math.max(1, Math.min(limit, 1000));
    const { rows } = await this.pool.query<CustodyHistoryRow>(
      `SELECT
         id_historial,
         secuencia,
         id_estudiante,
         id_viaje,
         estado_origen,
         estado_destino,
         disparador_evento,
         CASE
           WHEN coordenadas_gps IS NOT NULL THEN ST_Y(coordenadas_gps::geometry)::double precision
           ELSE NULL
         END AS latitud,
         CASE
           WHEN coordenadas_gps IS NOT NULL THEN ST_X(coordenadas_gps::geometry)::double precision
           ELSE NULL
         END AS longitud,
         fecha_hora,
         registrado_por_usuario,
         hash_sha256_anterior,
         hash_sha256_actual
       FROM public.historial_estado_custodia
       WHERE id_estudiante = $1
       ORDER BY fecha_hora DESC, secuencia DESC
       LIMIT $2`,
      [idEstudiante, safeLimit],
    );

    return rows.map((row) => this.mapHistoryRow(row));
  }

  async verifyHistoryIntegrity(
    limit = 10000,
  ): Promise<CustodyChainVerificationReport> {
    const safeLimit = Math.max(1, Math.min(limit, 50000));
    const { rows } = await this.pool.query<IntegrityRow>(
      `SELECT
         p_secuencia,
         es_valido,
         hash_esperado,
         hash_encontrado
       FROM public.fn_verificar_integridad_custodia($1)`,
      [safeLimit],
    );

    const registros: CustodyIntegrityCheckRow[] = rows.map((row) => ({
      secuencia: Number(row.p_secuencia),
      es_valido: row.es_valido,
      hash_esperado: row.hash_esperado,
      hash_encontrado: row.hash_encontrado,
    }));

    const failed = registros.find((r) => !r.es_valido);

    return {
      total_verificados: registros.length,
      cadena_integra: failed === undefined,
      secuencia_fallo: failed ? failed.secuencia : null,
      registros,
    };
  }

  async initializeMorningCustody(
    fecha: string,
  ): Promise<MorningInitializationSummary> {
    const { rows } = await this.pool.query<MorningInitRow>(
      `SELECT id_viaje, id_estudiante, estado_custodia
       FROM public.fn_inicializar_custodia_matutina($1::date)`,
      [fecha],
    );

    return {
      fecha,
      registros_inicializados: rows.length,
      registros: rows.map((row) => ({
        id_viaje: row.id_viaje,
        id_estudiante: row.id_estudiante,
        estado_custodia: row.estado_custodia,
      })),
    };
  }

  async finalizeTrip(idViaje: string): Promise<TripCustodyMeta> {
    try {
      const { rows } = await this.pool.query<TripRow>(
        `UPDATE public.viaje v
         SET estado = 'FINALIZADO'
         FROM public.ruta r
         WHERE v.id_viaje = $1
           AND r.id_ruta = v.id_ruta
         RETURNING
           v.id_viaje,
           v.id_ruta,
           v.fecha::text AS fecha,
           r.jornada,
           v.estado,
           v.hora_fin_real`,
        [idViaje],
      );

      if (!rows[0]) {
        throw new CustodyEnrollmentNotFoundError(idViaje, "VIAJE");
      }

      return this.mapTrip(rows[0]);
    } catch (error) {
      this.rethrowPgError(error, { idViaje });
    }
  }

  private mapCustodyRow(row: StudentTripCustodyRow): StudentTripCustodyRecord {
    return {
      id_viaje: row.id_viaje,
      id_estudiante: row.id_estudiante,
      estado_custodia: row.estado_custodia,
      es_pasajero_ocasional: row.es_pasajero_ocasional,
      hora_abordaje: row.hora_abordaje ? new Date(row.hora_abordaje) : null,
      hora_desembarque: row.hora_desembarque
        ? new Date(row.hora_desembarque)
        : null,
      actualizado_en: new Date(row.actualizado_en),
    };
  }

  private mapHistoryRow(row: CustodyHistoryRow): CustodyHistoryRecord {
    return {
      id_historial: row.id_historial,
      secuencia: Number(row.secuencia),
      id_estudiante: row.id_estudiante,
      id_viaje: row.id_viaje,
      estado_origen: row.estado_origen,
      estado_destino: row.estado_destino,
      disparador_evento: row.disparador_evento,
      coordenadas_gps:
        row.latitud != null && row.longitud != null
          ? {
              latitud: Number(row.latitud),
              longitud: Number(row.longitud),
            }
          : null,
      fecha_hora: new Date(row.fecha_hora),
      registrado_por_usuario: row.registrado_por_usuario ?? null,
      hash_sha256_anterior: row.hash_sha256_anterior,
      hash_sha256_actual: row.hash_sha256_actual,
    };
  }

  private mapTrip(row: TripRow): TripCustodyMeta {
    return {
      id_viaje: row.id_viaje,
      id_ruta: row.id_ruta,
      fecha:
        typeof row.fecha === "string"
          ? row.fecha.slice(0, 10)
          : new Date(row.fecha).toISOString().slice(0, 10),
      tipo_recorrido:
        row.jornada === "TARDE" ? TripDirection.TARDE : TripDirection.MANANA,
      estado: row.estado,
      hora_fin_real: row.hora_fin_real ? new Date(row.hora_fin_real) : null,
    };
  }

  private rethrowPgError(
    error: unknown,
    context: {
      idViaje?: string;
      idEstudiante?: string;
      toState?: string;
      tripDirection?: string;
    } = {},
  ): never {
    const pgErr = error as PgErrorLike;
    const message = pgErr?.message ?? "";

    if (pgErr?.code === "P0002") {
      throw new CustodyEnrollmentNotFoundError(
        context.idViaje ?? "",
        context.idEstudiante ?? "",
      );
    }

    if (pgErr?.code === "55000") {
      throw new WormImmutabilityViolationError(message || undefined);
    }

    if (pgErr?.code === "22023") {
      throw new InvalidCustodyCoordinatesError(
        message || "Coordenadas WGS84 inválidas.",
      );
    }

    if (pgErr?.code === "23514") {
      if (message.includes("BLOQUEO_CIERRE_VIAJE_CUSTODIA")) {
        const match = message.match(/existen (\d+) estudiante/);
        const count = match ? Number(match[1]) : 1;
        throw new TripClosureBlockedError(context.idViaje ?? "", count);
      }

      if (message.includes("VIOLACION_INVARIANTE_FSM")) {
        throw new CustodyInvariantViolationError(
          "DESCONOCIDO",
          context.toState ?? "DESCONOCIDO",
          context.tripDirection ?? "DESCONOCIDO",
          [],
          message,
        );
      }
    }

    throw error;
  }
}
