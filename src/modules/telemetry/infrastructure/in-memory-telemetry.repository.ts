import { Injectable } from "@nestjs/common";
import {
  ITelemetryRepository,
  VehicleLookupQuery,
} from "../domain/telemetry-repository.port";
import {
  formatGpsPartitionName,
  PartitionInfo,
  PersistedTelemetryRecord,
  PurgedPartitionInfo,
  ResolvedVehicleContext,
  TelemetryBatchPersistenceItem,
  TelemetryBatchPersistenceResult,
  TelemetryRecordToPersist,
} from "../domain/telemetry.types";

const DEFAULT_VEHICLE_WKK123: ResolvedVehicleContext = {
  id_vehiculo: "018e38d9-3f00-7200-a000-000000000123",
  placa: "WKK123",
  id_viaje: "018e38d9-3f00-7200-a000-000000000301",
};

/**
 * Repositorio en memoria de telemetría GPS con particionamiento mensual simulado
 * (`registro_gps_YYYY_MM`), deduplicación por `(id_vehiculo, fecha_hora)` y
 * retención configurable de 180 días (Issue #12).
 */
@Injectable()
export class InMemoryTelemetryRepository implements ITelemetryRepository {
  private readonly partitions = new Map<
    string,
    Map<string, PersistedTelemetryRecord>
  >();
  private readonly vehiclesByPlate = new Map<string, ResolvedVehicleContext>();
  private readonly vehiclesById = new Map<string, ResolvedVehicleContext>();

  constructor() {
    this.seedVehicleContext(DEFAULT_VEHICLE_WKK123);
    void this.ensureMonthlyPartitions(new Date(), 2);
  }

  seedVehicleContext(context: ResolvedVehicleContext): void {
    const normalized: ResolvedVehicleContext = {
      id_vehiculo: context.id_vehiculo,
      placa: context.placa.trim().toUpperCase(),
      id_viaje: context.id_viaje,
    };
    this.vehiclesByPlate.set(normalized.placa, normalized);
    this.vehiclesById.set(normalized.id_vehiculo, normalized);
  }

  async resolveVehicleContext(
    query: VehicleLookupQuery,
  ): Promise<ResolvedVehicleContext | null> {
    if (query.placa) {
      const byPlate = this.vehiclesByPlate.get(query.placa.trim().toUpperCase());
      if (byPlate) {
        return {
          ...byPlate,
          id_viaje: query.id_viaje ?? byPlate.id_viaje,
        };
      }
    }

    if (query.id_vehiculo) {
      const byId = this.vehiclesById.get(query.id_vehiculo);
      if (byId) {
        return {
          ...byId,
          id_viaje: query.id_viaje ?? byId.id_viaje,
        };
      }
      if (query.id_viaje) {
        return {
          id_vehiculo: query.id_vehiculo,
          placa: query.placa?.trim().toUpperCase() ?? "UNKNOWN",
          id_viaje: query.id_viaje,
        };
      }
    }

    return null;
  }

  async insertBatch(
    records: readonly TelemetryRecordToPersist[],
  ): Promise<TelemetryBatchPersistenceResult> {
    const inserted: TelemetryBatchPersistenceItem[] = [];
    let duplicateCount = 0;

    for (const record of records) {
      const partitionName = formatGpsPartitionName(record.fecha_hora);
      let partition = this.partitions.get(partitionName);
      if (!partition) {
        partition = new Map<string, PersistedTelemetryRecord>();
        this.partitions.set(partitionName, partition);
      }

      const dedupKey = `${record.id_vehiculo}|${record.fecha_hora.toISOString()}`;
      if (partition.has(dedupKey)) {
        duplicateCount += 1;
        continue;
      }

      const persisted: PersistedTelemetryRecord = {
        ...record,
        partition_name: partitionName,
      };
      partition.set(dedupKey, persisted);
      inserted.push({
        id_gps: record.id_gps,
        id_vehiculo: record.id_vehiculo,
        fecha_hora: record.fecha_hora,
        partition_name: partitionName,
      });
    }

    return { inserted, duplicateCount };
  }

  async ensureMonthlyPartitions(
    referenceDate: Date = new Date(),
    monthsAhead = 2,
  ): Promise<PartitionInfo[]> {
    if (!Number.isInteger(monthsAhead) || monthsAhead < 0 || monthsAhead > 24) {
      throw new Error("p_meses_adelante debe estar entre 0 y 24.");
    }

    const baseYear = referenceDate.getUTCFullYear();
    const baseMonth = referenceDate.getUTCMonth();
    const results: PartitionInfo[] = [];

    for (let i = 0; i <= monthsAhead; i += 1) {
      const start = new Date(Date.UTC(baseYear, baseMonth + i, 1, 0, 0, 0, 0));
      const end = new Date(
        Date.UTC(baseYear, baseMonth + i + 1, 1, 0, 0, 0, 0),
      );
      const partitionName = formatGpsPartitionName(start);
      const created = !this.partitions.has(partitionName);
      if (created) {
        this.partitions.set(partitionName, new Map());
      }
      results.push({
        nombre_particion: partitionName,
        inicio_rango: start,
        fin_rango: end,
        creada: created,
      });
    }

    return results;
  }

  async purgeExpiredPartitions(
    retentionDays = 180,
    referenceDate: Date = new Date(),
  ): Promise<PurgedPartitionInfo[]> {
    if (!Number.isInteger(retentionDays) || retentionDays < 30) {
      throw new Error("p_dias_retencion debe ser al menos 30 días.");
    }

    const cutoffMs =
      referenceDate.getTime() - retentionDays * 24 * 60 * 60 * 1000;
    const cutoffDate = new Date(cutoffMs);
    const cutoffDayUtc = Date.UTC(
      cutoffDate.getUTCFullYear(),
      cutoffDate.getUTCMonth(),
      cutoffDate.getUTCDate(),
    );

    const purged: PurgedPartitionInfo[] = [];
    for (const partitionName of Array.from(this.partitions.keys()).sort()) {
      const match = /^registro_gps_(\d{4})_(\d{2})$/.exec(partitionName);
      if (!match) {
        continue;
      }
      const year = Number(match[1]);
      const monthIndex = Number(match[2]) - 1;
      const monthEndUtc = Date.UTC(year, monthIndex + 1, 1);

      if (monthEndUtc <= cutoffDayUtc) {
        this.partitions.delete(partitionName);
        purged.push({
          nombre_particion: partitionName,
          fecha_mes: `${match[1]}-${match[2]}-01`,
          eliminada: true,
        });
      }
    }

    return purged;
  }

  async listRecentByVehicle(
    idVehiculo: string,
    limit = 50,
  ): Promise<PersistedTelemetryRecord[]> {
    const matches: PersistedTelemetryRecord[] = [];
    for (const partition of this.partitions.values()) {
      for (const record of partition.values()) {
        if (record.id_vehiculo === idVehiculo) {
          matches.push(record);
        }
      }
    }

    return matches
      .sort((a, b) => b.fecha_hora.getTime() - a.fecha_hora.getTime())
      .slice(0, limit);
  }

  getPartitionNames(): string[] {
    return Array.from(this.partitions.keys()).sort();
  }

  getPartitionCount(partitionName: string): number {
    return this.partitions.get(partitionName)?.size ?? 0;
  }

  getTotalRecordCount(): number {
    let total = 0;
    for (const partition of this.partitions.values()) {
      total += partition.size;
    }
    return total;
  }
}
