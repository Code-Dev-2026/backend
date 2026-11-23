import { Controller, Post, Body, Patch, Param } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { TripsService, DispatchTripDto } from "./trips.service";
import { ParseUUIDv7Pipe } from "@common/pipes/parse-uuidv7.pipe";

@ApiTags("Viajes y Monitoreo Operativo (Sprint 2)")
@Controller("trips")
export class TripsController {
  constructor(private readonly tripsService: TripsService) {}

  @Post("dispatch")
  @ApiOperation({
    summary:
      "Programar o despachar una instancia de viaje con exclusiones horarias btree_gist",
  })
  async dispatchTrip(@Body() dto: DispatchTripDto) {
    return this.tripsService.dispatchTrip(dto);
  }

  @Patch(":id/start")
  @ApiOperation({ summary: "Iniciar recorrido en ruta" })
  async startTrip(@Param("id", ParseUUIDv7Pipe) id: string) {
    return this.tripsService.startTrip(id);
  }

  @Patch(":id/finish")
  @ApiOperation({
    summary:
      "Finalizar recorrido en ruta (FINALIZADO), bloqueando cierre si hay menores A_BORDO_VEHICULO (Issue #7)",
  })
  @ApiResponse({ status: 200, description: "Viaje finalizado correctamente." })
  @ApiResponse({
    status: 409,
    description:
      "Cierre bloqueado: existen estudiantes en estado A_BORDO_VEHICULO.",
  })
  async finishTrip(@Param("id", ParseUUIDv7Pipe) id: string) {
    return this.tripsService.finishTrip(id);
  }
}
