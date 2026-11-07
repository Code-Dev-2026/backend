import { Injectable, Logger } from "@nestjs/common";

export interface GpsPacketDto {
  id_viaje: string;
  id_vehiculo: string;
  latitud: number;
  longitud: number;
  velocidad_kmh: number;
  rumbo: number;
  timestamp: string;
}

@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);

  /**
   * Procesa paquete telemático GPS recibido vía HTTPS o Broker MQTT
   */
  async processGpsTelemetry(packet: GpsPacketDto) {
    const simulatedDistanceToRouteMeters = 45;
    const isOffRoute = simulatedDistanceToRouteMeters > 300;

    const response = {
      recibido: true,
      timestamp: packet.timestamp,
      desviacion_metros: simulatedDistanceToRouteMeters,
      alerta_desvio: isOffRoute,
      zona_sombra_detectada: false,
    };

    if (isOffRoute) {
      this.logger.warn(
        `ALERTA AMARILLA: Vehículo ${packet.id_vehiculo} desvíado ${simulatedDistanceToRouteMeters}m de su ruta.`,
      );
    }

    return response;
  }

  async syncOfflineBatch(id_dispositivo: string, batchEvents: unknown[]) {
    return {
      id_dispositivo,
      eventos_procesados: batchEvents.length,
      estado_sync: "COMPLETADO_IDEMPOTENTE",
      timestamp: new Date().toISOString(),
    };
  }
}
