import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import {
  AuthenticatedUser,
  CurrentUser,
} from "@common/decorators/current-user.decorator";
import { IdempotencyKey } from "@common/decorators/idempotency-key.decorator";
import { Roles } from "@common/decorators/roles.decorator";
import { RoleEnum } from "@common/enums/role.enum";
import { AttendanceService } from "./attendance.service";
import { RegisterBoardingDto } from "./dto/register-boarding.dto";

const BOARDING_ALLOWED_ROLES = [
  RoleEnum.MONITORA,
  RoleEnum.ADMIN,
  RoleEnum.COORDINADORA_CONVIVENCIA,
  RoleEnum.JEFE_OPERACIONES,
] as const;

@ApiTags("Control de Asistencia y Aforo QR (Sprint 2)")
@ApiBearerAuth()
@Controller("asistencia")
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  @Post("abordaje")
  @HttpCode(HttpStatus.OK)
  @Roles(...BOARDING_ALLOWED_ROLES)
  @ApiOperation({
    summary:
      "Registrar abordaje atómico QR con control concurrente anti-sobrecupo (RF-08, RN-02, RN-05)",
  })
  @ApiHeader({
    name: "X-Idempotency-Key",
    required: false,
    description:
      "Clave idempotente opcional para bloquear reintentos duplicados por lentitud de red",
  })
  @ApiResponse({
    status: 200,
    description:
      "Respuesta JSON estructurada no fatal: ABORDAJE_EXITOSO, DENEGADO_SOBRECUPO o ABORDAJE_PREVIO_EXISTE.",
  })
  @ApiResponse({
    status: 400,
    description: "Payload o coordenadas WGS84 inválidas.",
  })
  @ApiResponse({
    status: 401,
    description: "Token JWT requerido o inválido.",
  })
  @ApiResponse({
    status: 403,
    description: "Rol sin permiso para registrar abordaje QR.",
  })
  @ApiResponse({
    status: 404,
    description: "Viaje no encontrado.",
  })
  @ApiResponse({
    status: 409,
    description: "El viaje no se encuentra en estado EN_CURSO.",
  })
  @ApiResponse({
    status: 422,
    description:
      "QR inválido/expirado o estudiante no asignado a la ruta del viaje.",
  })
  async registerBoarding(
    @Body() dto: RegisterBoardingDto,
    @CurrentUser() user?: AuthenticatedUser,
    @IdempotencyKey(false) headerIdempotencyKey?: string,
  ) {
    return this.attendanceService.registerBoarding({
      id_viaje: dto.id_viaje,
      qr_token: dto.qr_token,
      coordenadas_gps: dto.coordenadas_gps,
      id_parada: dto.id_parada,
      metodo_validacion: dto.metodo_validacion,
      sincronizado_offline: dto.sincronizado_offline,
      idempotency_key: headerIdempotencyKey ?? dto.idempotency_key ?? null,
      registrado_por_usuario: user?.id_usuario ?? null,
    });
  }
}
