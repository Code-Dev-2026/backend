import { Controller, Post, Body } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { TelemetryService, GpsPacketDto } from "./telemetry.service";

@ApiTags("Telemetría IoT Vehicular (Sprint 3)")
@Controller("telemetry")
export class TelemetryController {
  constructor(private readonly telemetryService: TelemetryService) {}

  @Post("packet")
  @ApiOperation({
    summary:
      "Ingesta de paquete GPS continuo (cada 5s) con cálculo de desvío > 300m",
  })
  @ApiResponse({ status: 200, description: "Paquete procesado." })
  async processPacket(@Body() packet: GpsPacketDto) {
    return this.telemetryService.processGpsTelemetry(packet);
  }
}
