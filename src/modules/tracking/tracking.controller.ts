import { Controller, Get, Param } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { TrackingService } from "./tracking.service";
import { ParseUUIDv7Pipe } from "@common/pipes/parse-uuidv7.pipe";

@ApiTags("Tracking en Tiempo Real y ETA (Sprint 3)")
@Controller("tracking")
export class TrackingController {
  constructor(private readonly trackingService: TrackingService) {}

  @Get(":id_viaje")
  @ApiOperation({
    summary: "Consultar posición en vivo y estimación de llegada (ETA)",
  })
  @ApiResponse({ status: 200, description: "Tracking en vivo obtenido." })
  async getLiveTracking(@Param("id_viaje", ParseUUIDv7Pipe) id_viaje: string) {
    return this.trackingService.getLiveTripTracking(id_viaje);
  }
}
