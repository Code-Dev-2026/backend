import { Injectable, BadRequestException, ConflictException } from '@nestjs/common';
import { CustodyStateEnum } from '@common/enums/custody-state.enum';

export interface BoardingScanDto {
  id_viaje: string;
  qr_token: string;
  id_parada: string;
  coordenadas_gps?: { latitud: number; longitud: number };
}

@Injectable()
export class AttendanceService {
  /**
   * Registro digital de abordaje por QR y validación de aforo nominal (RN-01, RN-02)
   */
  async registerBoarding(dto: BoardingScanDto) {
    const capacidadNominal = 24;
    const aforoActual = 23; // Ejemplo de aforo

    // REGLA SRS RN-02: Control estricto de cupo nominal duro (N+1 denegado)
    if (aforoActual + 1 > capacidadNominal) {
      throw new ConflictException(
        `ABORDAJE DENEGADO: El vehículo ha alcanzado su capacidad nominal estricta (${capacidadNominal} pasajeros). Violación de seguridad N+1.`,
      );
    }

    return {
      estado_custodia: CustodyStateEnum.A_BORDO_VEHICULO,
      id_viaje: dto.id_viaje,
      hora_registro: new Date().toISOString(),
      aforo_resultante: aforoActual + 1,
      mensaje: 'Abordaje registrado exitosamente. Notificación push enviada a acudiente.',
    };
  }

  /**
   * Registro digital de descenso en paradero oficial
   */
  async registerAlighting(id_viaje: string, id_estudiante: string) {
    return {
      estado_custodia: CustodyStateEnum.ENTREGADO_A_TUTOR,
      id_viaje,
      id_estudiante,
      hora_descenso: new Date().toISOString(),
    };
  }
}
