import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Roles } from "@common/decorators/roles.decorator";
import { RoleEnum } from "@common/enums/role.enum";
import { IngestGpsTelemetryDto } from "./dto/telemetry-gps.dto";
import { TelemetryService } from "./telemetry.service";

const TELEMETRY_INGEST_ROLES = [
  RoleEnum.CONDUCTOR,
  RoleEnum.MONITORA,
  RoleEnum.JEFE_OPERACIONES,
  RoleEnum.GERENCIA_TRANSPORTE,
  RoleEnum.ADMIN,
] as const;

@ApiTags("Telemetría IoT Vehicular (Sprint 3)")
@ApiBearerAuth()
@Controller("telemetria")
export class TelemetryController {
  constructor(private readonly telemetryService: TelemetryService) {}

  @Post("gps")
  @HttpCode(HttpStatus.OK)
  @Roles(...TELEMETRY_INGEST_ROLES)
  @ApiOperation({
    summary:
      "Endpoint HTTPS fallback para ingesta de telemetría GPS vehicular ante pérdida de conectividad MQTT (Issue #12, RF-10, RNF-05)",
  })
  @ApiResponse({
    status: 200,
    description:
      "Paquete evaluado: almacenado en partición mensual (`STORED`), descartado por baja precisión > 30 m (`DISCARDED_LOW_ACCURACY`) o deduplicado (`DUPLICATE_IGNORED`).",
  })
  @ApiResponse({
    status: 400,
    description: "Paquete telemático malformado o fuera de rango.",
  })
  @ApiResponse({
    status: 401,
    description: "Token JWT requerido o inválido.",
  })
  @ApiResponse({
    status: 403,
    description: "Rol sin permiso para reportar telemetría vehicular.",
  })
  @ApiResponse({
    status: 404,
    description: "Vehículo inactivo/no encontrado o sin viaje operativo asociado.",
  })
  async ingestGpsFallback(@Body() dto: IngestGpsTelemetryDto) {
    if (!dto.placa && !dto.id_vehiculo) {
      throw new BadRequestException(
        "Debe especificar placa o id_vehiculo en el paquete telemático.",
      );
    }

    const result = await this.telemetryService.ingestHttpFallback(dto);

    if (result.status === "REJECTED") {
      if (result.reason === "UNKNOWN_VEHICLE") {
        throw new NotFoundException({
          codigo: result.reason,
          mensaje: result.details,
        });
      }
      throw new BadRequestException({
        codigo: result.reason,
        mensaje: result.details,
      });
    }

    return result;
  }
}
