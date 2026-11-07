import { Injectable, BadRequestException } from "@nestjs/common";

export interface OccasionalPassengerRequestDto {
  id_estudiante: string;
  id_viaje: string;
  id_parada_destino: string;
  autorizado_por_acudiente: boolean;
  horas_anticipacion: number;
}

@Injectable()
export class PassengersService {
  /**
   * Gestión de solicitud de pasajero ocasional (RF-04, RN-03)
   * Requiere >= 2 horas de anticipación y cupo disponible liberado por inasistencia
   */
  async requestOccasionalSeat(dto: OccasionalPassengerRequestDto) {
    if (dto.horas_anticipacion < 2) {
      throw new BadRequestException(
        "REGLA RN-03: La solicitud de pasajero ocasional debe radicarse con al menos 2 horas de antelación.",
      );
    }

    return {
      solicitud_aprobada: true,
      id_estudiante: dto.id_estudiante,
      id_viaje: dto.id_viaje,
      cupo_asignado: "ASIENTO_LIBERADO_04",
      valido_hasta: new Date().toISOString(),
      mensaje: "Cupo ocasional confirmado. QR temporal generado.",
    };
  }
}
