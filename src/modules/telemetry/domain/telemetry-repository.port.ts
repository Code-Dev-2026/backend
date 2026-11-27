import {
  PartitionInfo,
  PersistedTelemetryRecord,
  PurgedPartitionInfo,
  ResolvedVehicleContext,
  TelemetryBatchPersistenceResult,
  TelemetryRecordToPersist,
} from "./telemetry.types";

export const TELEMETRY_REPOSITORY = Symbol("TELEMETRY_REPOSITORY");

export interface VehicleLookupQuery {
  readonly id_vehiculo?: string;
  readonly placa?: string;
  readonly id_viaje?: string;
}

export interface ITelemetryRepository {
  resolveVehicleContext(
    query: VehicleLookupQuery,
  ): Promise<ResolvedVehicleContext | null>;

  insertBatch(
    records: readonly TelemetryRecordToPersist[],
  ): Promise<TelemetryBatchPersistenceResult>;

  ensureMonthlyPartitions(
    referenceDate?: Date,
    monthsAhead?: number,
  ): Promise<PartitionInfo[]>;

  purgeExpiredPartitions(
    retentionDays?: number,
    referenceDate?: Date,
  ): Promise<PurgedPartitionInfo[]>;

  listRecentByVehicle(
    idVehiculo: string,
    limit?: number,
  ): Promise<PersistedTelemetryRecord[]>;
}
