import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);

  /**
   * Determina si un acudiente tiene derecho a ver la posición del móvil:
   * Solo si su hijo/a se encuentra actualmente en estado A_BORDO_VEHICULO (Privacidad Diferencial)
   */
  canParentTrackVehicle(id_acudiente: string, id_viaje: string, isStudentOnBoard: boolean): boolean {
    return isStudentOnBoard;
  }
}
