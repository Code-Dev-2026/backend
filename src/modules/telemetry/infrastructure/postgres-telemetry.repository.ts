import { Injectable, OnModuleDestroy } from "@nestjs/common";
import type { Pool, PoolConfig } from "pg";
import {
  ITelemetryRepository,
  VehicleLookupQuery,
} from "../domain/telemetry-repository.port";
import {
  PartitionInfo,
  PersistedTelemetryRecord,
  PurgedPartitionInfo,
  ResolvedVehicleContext,
  TelemetryBatchPersistenceItem,
  TelemetryBatchPersistenceResult,
  TelemetryRecordToPersist,
} from "../domain/telemetry.types";

interface VehicleContextRow {
  id_vehiculo: string;
  placa: string;
  id_viaje: string | null;
}

interface InsertedGpsRow {
  id_gps: string;
  id_vehiculo: string;
  fecha_hora: Date;
  partition_name: string;
}

interface PartitionRow {
  nombre_particion: string;
  inicio_rango: Date;
  fin_rango: Date;
  creada: boolean;
}

interface PurgedPartitionRow {
  nombre_particion: string;
  fecha_mes: string | Date;
  eliminada: boolean;
}

interface RecentGpsRow {
  id_gps: string;
  id_viaje: string;
  id_vehiculo: string;
  placa: string;
  latitud: number;
  longitud: number;
  velocidad_kmh: string | number;
  rumbo_grados: string | number;
  precision_hdop: string | number;
  precision_metros: string | number | null;
  odometro_km: string | number | null;
  bateria_respaldo_activa: boolean;
  fecha_hora: Date;
  partition_name: string;
}

interface CachedVehicleEntry {
  readonly context: ResolvedVehicleContext;
  readonly expiresAtMs: number;
}

const VEHICLE_CACHE_TTL_MS = 30_000;

/**
 * Adaptador PostgreSQL 16 + PostGIS 3.4 para ingesta masiva de telemetría GPS
 * en la tabla particionada `public.registro_gps` (Issue #12 - V005 + V019).
 *
 * Usa inserciones batch optimizadas vía `UNNEST` con deduplicación atómica
 * (`ON CONFLICT (id_vehiculo, fecha_hora) DO NOTHING`) y gestión de particiones
 * mediante `fn_crear_particion_gps_mensual` y `fn_purgar_particiones_gps_vencidas`.
 */
@Injectable()
export class PostgresTelemetryRepository
  implements ITelemetryRepository, OnModuleDestroy
{
  private readonly vehicleCache = new Map<string, CachedVehicleEntry>();

  constructor(
    private readonly pool: Pool,
    private readonly ownsPool = false,
  ) {}

  static fromConfig(config: PoolConfig): PostgresTelemetryRepository {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Pool: PgPool } = require("pg") as typeof import("pg");
    return new PostgresTelemetryRepository(new PgPool(config), true);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  clearCache(): void {
    this.vehicleCache.clear();
  }

  async resolveVehicleContext(
    query: VehicleLookupQuery,
  ): Promise<ResolvedVehicleContext | null> {
    const normalizedPlate = query.placa?.trim().toUpperCase();
    const cacheKey = `${query.id_vehiculo ?? ""}|${normalizedPlate ?? ""}|${query.id_viaje ?? ""}`;
    const cached = this.vehicleCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.context;
    }

    const res = await this.pool.query<VehicleContextRow>(
      `SELECT
         vh.id_vehiculo,
         vh.placa,
         COALESCE(
           $3::uuid,
           (
             SELECT v.id_viaje
             FROM public.viaje v
             WHERE v.id_vehiculo = vh.id_vehiculo
               AND v.estado IN ('EN_CURSO', 'PROGRAMADO')
             ORDER BY
               CASE WHEN v.estado = 'EN_CURSO' THEN 0 ELSE 1 END,
               v.hora_inicio_programada DESC
             LIMIT 1
           )
         ) AS id_viaje
       FROM public.vehiculo vh
       WHERE vh.activo = TRUE
         AND (
           ($1::uuid IS NOT NULL AND vh.id_vehiculo = $1::uuid)
           OR ($2::varchar IS NOT NULL AND UPPER(vh.placa) = $2::varchar)
         )
       LIMIT 1`,
      [query.id_vehiculo ?? null, normalizedPlate ?? null, query.id_viaje ?? null],
    );

    const row = res.rows[0];
    if (!row || !row.id_viaje) {
      return null;
    }

    const context: ResolvedVehicleContext = {
      id_vehiculo: row.id_vehiculo,
      placa: row.placa.toUpperCase(),
      id_viaje: row.id_viaje,
    };

    this.vehicleCache.set(cacheKey, {
      context,
      expiresAtMs: Date.now() + VEHICLE_CACHE_TTL_MS,
    });

    return context;
  }

  async insertBatch(
    records: readonly TelemetryRecordToPersist[],
  ): Promise<TelemetryBatchPersistenceResult> {
    if (records.length === 0) {
      return { inserted: [], duplicateCount: 0 };
    }

    const ids: string[] = [];
    const tripIds: string[] = [];
    const vehicleIds: string[] = [];
    const longitudes: number[] = [];
    const latitudes: number[] = [];
    const speeds: number[] = [];
    const headings: number[] = [];
    const hdops: number[] = [];
    const accuracies: number[] = [];
    const odometers: number[] = [];
    const backupBatteries: boolean[] = [];
    const timestamps: string[] = [];

    for (const rec of records) {
      ids.push(rec.id_gps);
      tripIds.push(rec.id_viaje);
      vehicleIds.push(rec.id_vehiculo);
      longitudes.push(rec.longitud);
      latitudes.push(rec.latitud);
      speeds.push(rec.velocidad_kmh);
      headings.push(rec.rumbo_grados);
      hdops.push(rec.precision_hdop);
      accuracies.push(rec.precision_metros);
      odometers.push(rec.odometro_km);
      backupBatteries.push(rec.bateria_respaldo_activa);
      timestamps.push(rec.fecha_hora.toISOString());
    }

    const res = await this.pool.query<InsertedGpsRow>(
      `INSERT INTO public.registro_gps (
         id_gps,
         id_viaje,
         id_vehiculo,
         coordenada,
         velocidad_kmh,
         rumbo_grados,
         precision_hdop,
         precision_metros,
         odometro_km,
         bateria_respaldo_activa,
         fecha_hora
       )
       SELECT
         u.id_gps,
         u.id_viaje,
         u.id_vehiculo,
         ST_SetSRID(ST_MakePoint(u.longitud, u.latitud), 4326)::geography,
         u.velocidad_kmh,
         u.rumbo_grados,
         u.precision_hdop,
         u.precision_metros,
         u.odometro_km,
         u.bateria_respaldo_activa,
         u.fecha_hora
       FROM unnest(
         $1::uuid[],
         $2::uuid[],
         $3::uuid[],
         $4::double precision[],
         $5::double precision[],
         $6::numeric[],
         $7::numeric[],
         $8::numeric[],
         $9::numeric[],
         $10::numeric[],
         $11::boolean[],
         $12::timestamptz[]
       ) AS u(
         id_gps,
         id_viaje,
         id_vehiculo,
         longitud,
         latitud,
         velocidad_kmh,
         rumbo_grados,
         precision_hdop,
         precision_metros,
         odometro_km,
         bateria_respaldo_activa,
         fecha_hora
       )
       ON CONFLICT (id_vehiculo, fecha_hora) DO NOTHING
       RETURNING
         id_gps,
         id_vehiculo,
         fecha_hora,
         tableoid::regclass::text AS partition_name`,
      [
        ids,
        tripIds,
        vehicleIds,
        longitudes,
        latitudes,
        speeds,
        headings,
        hdops,
        accuracies,
        odometers,
        backupBatteries,
        timestamps,
      ],
    );

    const inserted: TelemetryBatchPersistenceItem[] = res.rows.map((row) => ({
      id_gps: row.id_gps,
      id_vehiculo: row.id_vehiculo,
      fecha_hora:
        row.fecha_hora instanceof Date
          ? row.fecha_hora
          : new Date(row.fecha_hora),
      partition_name: row.partition_name.replace(/^public\./, ""),
    }));

    return {
      inserted,
      duplicateCount: records.length - inserted.length,
    };
  }

  async ensureMonthlyPartitions(
    referenceDate: Date = new Date(),
    monthsAhead = 2,
  ): Promise<PartitionInfo[]> {
    const res = await this.pool.query<PartitionRow>(
      `SELECT nombre_particion, inicio_rango, fin_rango, creada
       FROM public.fn_crear_particion_gps_mensual($1::timestamptz, $2::int)`,
      [referenceDate.toISOString(), monthsAhead],
    );

    return res.rows.map((row) => ({
      nombre_particion: row.nombre_particion,
      inicio_rango:
        row.inicio_rango instanceof Date
          ? row.inicio_rango
          : new Date(row.inicio_rango),
      fin_rango:
        row.fin_rango instanceof Date
          ? row.fin_rango
          : new Date(row.fin_rango),
      creada: Boolean(row.creada),
    }));
  }

  async purgeExpiredPartitions(
    retentionDays = 180,
    referenceDate: Date = new Date(),
  ): Promise<PurgedPartitionInfo[]> {
    const res = await this.pool.query<PurgedPartitionRow>(
      `SELECT nombre_particion, fecha_mes, eliminada
       FROM public.fn_purgar_particiones_gps_vencidas($1::int, $2::timestamptz)`,
      [retentionDays, referenceDate.toISOString()],
    );

    return res.rows.map((row) => ({
      nombre_particion: row.nombre_particion,
      fecha_mes:
        row.fecha_mes instanceof Date
          ? row.fecha_mes.toISOString().slice(0, 10)
          : String(row.fecha_mes).slice(0, 10),
      eliminada: Boolean(row.eliminada),
    }));
  }

  async listRecentByVehicle(
    idVehiculo: string,
    limit = 50,
  ): Promise<PersistedTelemetryRecord[]> {
    const res = await this.pool.query<RecentGpsRow>(
      `SELECT
         g.id_gps,
         g.id_viaje,
         g.id_vehiculo,
         COALESCE(vh.placa, '') AS placa,
         ST_Y(g.coordenada::geometry) AS latitud,
         ST_X(g.coordenada::geometry) AS longitud,
         g.velocidad_kmh,
         g.rumbo_grados,
         g.precision_hdop,
         g.precision_metros,
         g.odometro_km,
         g.bateria_respaldo_activa,
         g.fecha_hora,
         g.tableoid::regclass::text AS partition_name
       FROM public.registro_gps g
       LEFT JOIN public.vehiculo vh ON vh.id_vehiculo = g.id_vehiculo
       WHERE g.id_vehiculo = $1::uuid
       ORDER BY g.fecha_hora DESC
       LIMIT $2::int`,
      [idVehiculo, limit],
    );

    return res.rows.map((row) => ({
      id_gps: row.id_gps,
      id_viaje: row.id_viaje,
      id_vehiculo: row.id_vehiculo,
      placa: row.placa,
      latitud: Number(row.latitud),
      longitud: Number(row.longitud),
      velocidad_kmh: Number(row.velocidad_kmh),
      rumbo_grados: Number(row.rumbo_grados),
      precision_hdop: Number(row.precision_hdop),
      precision_metros: Number(row.precision_metros ?? 0),
      odometro_km: Number(row.odometro_km ?? 0),
      bateria_respaldo_activa: Boolean(row.bateria_respaldo_activa),
      fecha_hora:
        row.fecha_hora instanceof Date
          ? row.fecha_hora
          : new Date(row.fecha_hora),
      partition_name: row.partition_name.replace(/^public\./, ""),
      source: "MQTT",
      receivedAtMs: Date.now(),
    }));
  }
}
