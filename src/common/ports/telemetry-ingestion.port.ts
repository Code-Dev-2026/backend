export interface TelemetryPacket {
  id_vehiculo: string;
  latitud: number;
  longitud: number;
  velocidad_kmh: number;
  rumbo_grados?: number;
  altitud_metros?: number;
  timestamp: string;
}

/**
 * Puerto de Dominio: Ingesta de Telemetría IoT Vehicular
 */
export interface ITelemetryIngestionPort {
  ingest(
    packet: TelemetryPacket,
  ): Promise<{ success: boolean; recordedAt: string }>;
  isInsideGeofence?(
    latitud: number,
    longitud: number,
    geofenceId: string,
  ): Promise<boolean>;
}
