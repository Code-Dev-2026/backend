import { Controller, Get, Param } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { RoutesService } from "./routes.service";
import { ParseUUIDv7Pipe } from "@common/pipes/parse-uuidv7.pipe";

@ApiTags("Rutas Escolares y Georreferenciación (Sprint 2)")
@Controller("routes")
export class RoutesController {
  constructor(private readonly routesService: RoutesService) {}

  @Get(":id")
  @ApiOperation({
    summary:
      "Consultar ruta escolar con trazado y secuencia ordenada de paradas PostGIS GiST",
  })
  @ApiResponse({ status: 200, description: "Detalle de la ruta obtenido." })
  async getRoute(@Param("id", ParseUUIDv7Pipe) id: string) {
    return this.routesService.getRouteDetails(id);
  }
}
