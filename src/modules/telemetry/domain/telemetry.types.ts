export type TelemetrySource = "MQTT" | "HTTP_FALLBACK" | "SIMULATOR";

export const TELEMETRY_GPS_RECORDED_EVENT = "telemetry.gps.recorded";

export type TelemetryRejectionReason =
  | "PAYLOAD_TOO_LARGE"
  | "MALFORMED_JSON"
  | "INVALID_SCHEMA"
  | "TOPIC_VEHICLE_MISMATCH"
  | "LOW_GPS_ACCURACY"
  | "INVALID_TIMESTAMP"
  | "FUTURE_TIMESTAMP"
  | "UNKNOWN_VEHICLE";

export type TelemetryIngestStatus =
  | "STORED"
  | "DISCARDED_LOW_ACCURACY"
  | "DUPLICATE_IGNORED"
  | "REJECTED";

export interface RawTelemetryEnvelope {
  readonly source: TelemetrySource;
  readonly topic?: string;
  readonly vehicleIdentifier?: string;
  readonly receivedAtMs: number;
  readonly payload: unknown;
}

export interface ValidatedTelemetryPacket {
  readonly id_vehiculo?: string;
  readonly placa?: string;
  readonly id_viaje?: string;
  readonly latitud: number;
  readonly longitud: number;
  readonly velocidad_kmh: number;
  readonly rumbo_grados: number;
  readonly precision_metros: number;
  readonly precision_hdop: number;
  readonly odometro_km: number;
  readonly bateria_respaldo_activa: boolean;
  readonly fecha_hora: Date;
  readonly source: TelemetrySource;
}

export interface ResolvedVehicleContext {
  readonly id_vehiculo: string;
  readonly placa: string;
  readonly id_viaje: string;
}

export interface TelemetryRecordToPersist {
  readonly id_gps: string;
  readonly id_viaje: string;
  readonly id_vehiculo: string;
  readonly placa: string;
  readonly latitud: number;
  readonly longitud: number;
  readonly velocidad_kmh: number;
  readonly rumbo_grados: number;
  readonly precision_hdop: number;
  readonly precision_metros: number;
  readonly odometro_km: number;
  readonly bateria_respaldo_activa: boolean;
  readonly fecha_hora: Date;
  readonly source: TelemetrySource;
  readonly receivedAtMs: number;
}

export interface PersistedTelemetryRecord extends TelemetryRecordToPersist {
  readonly partition_name: string;
}

export interface TelemetryRecordedEventPayload {
  readonly id_gps: string;
  readonly id_viaje: string;
  readonly id_vehiculo: string;
  readonly placa: string;
  readonly latitud: number;
  readonly longitud: number;
  readonly velocidad_kmh: number;
  readonly rumbo_grados: number;
  readonly precision_metros: number;
  readonly precision_hdop: number;
  readonly odometro_km: number;
  readonly bateria_respaldo_activa: boolean;
  readonly fecha_hora: string;
  readonly partition_name: string;
  readonly source: TelemetrySource;
  readonly latency_ms: number;
}

export interface TelemetryIngestResult {
  readonly status: TelemetryIngestStatus;
  readonly stored: boolean;
  readonly dispatched: boolean;
  readonly id_gps: string | null;
  readonly id_vehiculo: string | null;
  readonly placa: string | null;
  readonly id_viaje: string | null;
  readonly partition_name: string | null;
  readonly latency_ms: number;
  readonly reason?: TelemetryRejectionReason;
  readonly details?: string;
}

export interface PartitionInfo {
  readonly nombre_particion: string;
  readonly inicio_rango: Date;
  readonly fin_rango: Date;
  readonly creada: boolean;
}

export interface PurgedPartitionInfo {
  readonly nombre_particion: string;
  readonly fecha_mes: string;
  readonly eliminada: boolean;
}

export interface PartitionMaintenanceSummary {
  readonly executed_at: string;
  readonly created_or_verified: PartitionInfo[];
  readonly purged: PurgedPartitionInfo[];
}

export interface TelemetryBatchPersistenceItem {
  readonly id_gps: string;
  readonly id_vehiculo: string;
  readonly fecha_hora: Date;
  readonly partition_name: string;
}

export interface TelemetryBatchPersistenceResult {
  readonly inserted: TelemetryBatchPersistenceItem[];
  readonly duplicateCount: number;
}

export function formatGpsPartitionName(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `registro_gps_${year}_${month}`;
}
