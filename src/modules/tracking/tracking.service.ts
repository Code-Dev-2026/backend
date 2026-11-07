import { Injectable } from "@nestjs/common";

@Injectable()
export class TrackingService {
  /**
   * Consulta el estado de tracking en vivo de un vehículo o viaje
   */
  async getLiveTripTracking(id_viaje: string) {
    return {
      id_viaje,
      latitud: 4.8145,
      longitud: -75.6942,
      velocidad_kmh: 38,
      rumbo: 120,
      proxima_parada: "Av. Circunvalar Calle 14",
      eta_minutos: 4,
      desviacion_metros: 22,
      estado_geocerca: "EN_RUTA_NORMAL",
      timestamp: new Date().toISOString(),
    };
  }
}
