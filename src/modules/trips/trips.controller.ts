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
  @ApiOperation({ summary: "Finalizar recorrido en ruta" })
  async finishTrip(@Param("id", ParseUUIDv7Pipe) id: string) {
    return this.tripsService.finishTrip(id);
  }
}
