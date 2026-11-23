import { Injectable, BadRequestException, Optional } from "@nestjs/common";
import { TripStateEnum } from "@common/enums/trip-state.enum";
import { CustodyService } from "../custody/custody.service";

export interface DispatchTripDto {
  id_ruta: string;
  id_vehiculo: string;
  id_conductor: string;
  id_monitora: string;
  sentido: "IDA_COLEGIO" | "REGRESO_CASA";
}

@Injectable()
export class TripsService {
  constructor(
    @Optional()
    private readonly custodyService?: CustodyService,
  ) {}

  async dispatchTrip(dto: DispatchTripDto) {
    if (!dto.id_ruta || !dto.id_vehiculo) {
      throw new BadRequestException(
        "Faltan datos obligatorios para programar el viaje.",
      );
    }

    const id_viaje = "018e38d9-3f00-7200-a000-000000000030";
    return {
      id_viaje,
      ...dto,
      estado: TripStateEnum.PROGRAMADO,
      aforo_actual: 0,
      iniciado_en: null,
      creado_en: new Date().toISOString(),
    };
  }

  async startTrip(id_viaje: string) {
    return {
      id_viaje,
      estado: TripStateEnum.EN_CURSO,
      iniciado_en: new Date().toISOString(),
    };
  }

  /**
   * Finaliza el recorrido operativo (`FINALIZADO`), bloqueando el cierre
   * si existen menores aún en estado `A_BORDO_VEHICULO` (Issue #7).
   */
  async finishTrip(id_viaje: string) {
    if (this.custodyService) {
      await this.custodyService.assertTripCanFinalize(id_viaje);
    }

    return {
      id_viaje,
      estado: TripStateEnum.FINALIZADO,
      finalizado_en: new Date().toISOString(),
    };
  }
}
