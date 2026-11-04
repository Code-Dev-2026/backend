import { Injectable, Logger } from '@nestjs/common';

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
    // Cálculo de desviación geoespacial (ST_Distance con la geometría oficial de la ruta)
    const simulatedDistanceToRouteMeters = 45; // Simulación: ruta normal
    const isOffRoute = simulatedDistanceToRouteMeters > 300; // Umbral RF-18

    const response = {
      recibido: true,
      timestamp: packet.timestamp,
      desviacion_metros: simulatedDistanceToRouteMeters,
      alerta_desvio: isOffRoute,
      zona_sombra_detectada: false,
    };

    if (isOffRoute) {
      this.logger.warn(`ALERTA AMARILLA: Vehículo ${packet.id_vehiculo} desvíado ${simulatedDistanceToRouteMeters}m de su ruta.`);
    }

    return response;
  }

  /**
   * Sincronización de lotes de telemetría / eventos en cola offline (Puntos Ciegos)
   */
  async syncOfflineBatch(id_dispositivo: string, batchEvents: unknown[]) {
    return {
      id_dispositivo,
      eventos_procesados: batchEvents.length,
      estado_sync: 'COMPLETADO_IDEMPOTENTE',
      timestamp: new Date().toISOString(),
    };
  }
}
