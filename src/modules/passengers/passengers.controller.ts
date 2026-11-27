import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import {
  AuthenticatedUser,
  CurrentUser,
} from "@common/decorators/current-user.decorator";
import { Roles } from "@common/decorators/roles.decorator";
import { RoleEnum } from "@common/enums/role.enum";
import {
  ApproveOccasionalPassengerDto,
  RequestOccasionalPassengerDto,
} from "./dto/occasional-passenger.dto";
import { OccasionalBookingService } from "./occasional-booking.service";

const OCCASIONAL_REQUEST_ROLES = [RoleEnum.ACUDIENTE] as const;

const OCCASIONAL_APPROVAL_ROLES = [
  RoleEnum.COORDINADORA_CONVIVENCIA,
  RoleEnum.RECTORIA,
  RoleEnum.ADMIN,
] as const;

@ApiTags("Pasajeros Ocasionales y Reasignación de Cupos (Sprint 2)")
@ApiBearerAuth()
@Controller("pasajeros-ocasionales")
export class PassengersController {
  constructor(
    private readonly occasionalBookingService: OccasionalBookingService,
  ) {}

  @Post("solicitar")
  @HttpCode(HttpStatus.CREATED)
  @Roles(...OCCASIONAL_REQUEST_ROLES)
  @ApiOperation({
    summary:
      "Radicar solicitud de pasajero ocasional validando antelación >= 2h, vacante por inasistencia previa y vínculo acudiente-estudiante (RF-05, RN-03, ASVS V4.1)",
  })
  @ApiResponse({
    status: 201,
    description:
      "Solicitud radicada con cupo liberado reservado atómicamente (estado RADICADA).",
  })
  @ApiResponse({
    status: 400,
    description: "Payload o identificadores UUID inválidos.",
  })
  @ApiResponse({
    status: 401,
    description: "Token JWT requerido o inválido.",
  })
  @ApiResponse({
    status: 403,
    description:
      "Rol no permitido o el acudiente autenticado no está vinculado al estudiante solicitado (OWASP ASVS V4.1).",
  })
  @ApiResponse({
    status: 404,
    description: "Viaje o estudiante no encontrado.",
  })
  @ApiResponse({
    status: 409,
    description:
      "Viaje no PROGRAMADO, estudiante ya asignado a la ruta o solicitud duplicada.",
  })
  @ApiResponse({
    status: 422,
    description:
      "Incumplimiento de RN-03: antelación < 2h, sin vacante por inasistencia previa y/o capacidad nominal agotada.",
  })
  async requestOccasionalSeat(
    @Body() dto: RequestOccasionalPassengerDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.occasionalBookingService.requestOccasionalSeat({
      id_viaje: dto.id_viaje,
      id_estudiante: dto.id_estudiante,
      solicitado_por_usuario: user.id_usuario,
      motivo: dto.motivo ?? null,
    });
  }

  @Post("aprobar")
  @HttpCode(HttpStatus.OK)
  @Roles(...OCCASIONAL_APPROVAL_ROLES)
  @ApiOperation({
    summary:
      "Aprobar solicitud de pasajero ocasional por Coordinación e incluir automáticamente al estudiante en viaje_estudiante (RF-05, RN-03)",
  })
  @ApiResponse({
    status: 200,
    description:
      "Solicitud aprobada (APROBADO_COORDINACION) y estudiante incluido atómicamente en viaje_estudiante.",
  })
  @ApiResponse({
    status: 400,
    description: "Payload inválido.",
  })
  @ApiResponse({
    status: 401,
    description: "Token JWT requerido o MFA no verificado.",
  })
  @ApiResponse({
    status: 403,
    description:
      "Rol sin potestad de Coordinación o coordinador no perteneciente al colegio de la ruta.",
  })
  @ApiResponse({
    status: 404,
    description: "Solicitud de pasajero ocasional no encontrada.",
  })
  @ApiResponse({
    status: 409,
    description:
      "Solicitud no se encuentra en estado RADICADA o viaje no PROGRAMADO.",
  })
  @ApiResponse({
    status: 422,
    description:
      "Vacante no disponible o sobrecupo detectado al intentar aprobar.",
  })
  async approveOccasionalSeat(
    @Body() dto: ApproveOccasionalPassengerDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.occasionalBookingService.approveOccasionalSeat({
      id_pasajero_ocasional: dto.id_pasajero_ocasional,
      aprobado_por_usuario: user.id_usuario,
      id_coordinador: dto.id_coordinador ?? null,
    });
  }
}
