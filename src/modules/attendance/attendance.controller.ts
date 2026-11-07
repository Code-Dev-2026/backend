import { Controller, Post, Body } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { AttendanceService, BoardingScanDto } from "./attendance.service";

@ApiTags("Control de Asistencia y Aforo QR (Sprint 2)")
@Controller("attendance")
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  @Post("boarding")
  @ApiOperation({
    summary:
      "Registrar abordaje atómico por lectura QR con verificación de aforo N+1 (RN-02)",
  })
  @ApiResponse({ status: 200, description: "Abordaje registrado." })
  @ApiResponse({
    status: 409,
    description: "Sobrecupo detectado. Abordaje denegado.",
  })
  async registerBoarding(@Body() dto: BoardingScanDto) {
    return this.attendanceService.registerBoarding(dto);
  }

  @Post("alighting")
  @ApiOperation({ summary: "Registrar descenso de menor en paradero" })
  async registerAlighting(
    @Body("id_viaje") id_viaje: string,
    @Body("id_estudiante") id_estudiante: string,
  ) {
    return this.attendanceService.registerAlighting(id_viaje, id_estudiante);
  }
}
