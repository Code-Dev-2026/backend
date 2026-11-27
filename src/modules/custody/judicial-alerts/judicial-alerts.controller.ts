import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import {
  AuthenticatedUser,
  CurrentUser,
} from "@common/decorators/current-user.decorator";
import { Roles } from "@common/decorators/roles.decorator";
import { RoleEnum } from "@common/enums/role.enum";
import { ParseUUIDv7Pipe } from "@common/pipes/parse-uuidv7.pipe";
import {
  CreateJudicialAlertDto,
  DeactivateJudicialAlertDto,
  ListJudicialAlertsQueryDto,
  VerifyJudicialAlertDto,
} from "./dto/judicial-alert.dto";
import { JudicialAlertsService } from "./judicial-alerts.service";

const JUDICIAL_ALERT_MANAGE_ROLES = [
  RoleEnum.COORDINADORA_CONVIVENCIA,
  RoleEnum.RECTORIA,
  RoleEnum.ADMIN,
] as const;

const JUDICIAL_ALERT_VERIFY_ROLES = [
  RoleEnum.MONITORA,
  RoleEnum.COORDINADORA_CONVIVENCIA,
  RoleEnum.RECTORIA,
  RoleEnum.ADMIN,
  RoleEnum.JEFE_OPERACIONES,
] as const;

@ApiTags("Motor de Protección Preventiva contra Alertas Judiciales (Sprint 2)")
@ApiBearerAuth()
@Controller("custody/judicial-alerts")
export class JudicialAlertsController {
  constructor(private readonly judicialAlertsService: JudicialAlertsService) {}

  @Post()
  @Roles(...JUDICIAL_ALERT_MANAGE_ROLES)
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary:
      "Registrar medida cautelar / alerta judicial cifrada con AES-256-GCM y blind index HMAC-SHA256 (RF-02, RNF-01)",
  })
  @ApiResponse({
    status: 201,
    description: "Alerta judicial registrada y cifrada en reposo.",
  })
  @ApiResponse({
    status: 400,
    description: "Datos de orden judicial o documento restringido inválidos.",
  })
  @ApiResponse({
    status: 403,
    description: "Rol sin potestad institucional o sin MFA activo.",
  })
  @ApiResponse({
    status: 409,
    description: "Radicado de medida cautelar duplicado.",
  })
  async createAlert(
    @Body() dto: CreateJudicialAlertDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.judicialAlertsService.createAlert(dto, user.id_usuario);
  }

  @Get("students/:studentId")
  @Roles(...JUDICIAL_ALERT_MANAGE_ROLES)
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary:
      "Consultar alertas judiciales de un estudiante (documento enmascarado; sin caché HTTP)",
  })
  @ApiParam({ name: "studentId", description: "UUID del estudiante" })
  @ApiResponse({
    status: 200,
    description: "Listado de alertas judiciales del estudiante.",
  })
  async listStudentAlerts(
    @Param("studentId", ParseUUIDv7Pipe) studentId: string,
    @Query() query: ListJudicialAlertsQueryDto,
  ) {
    return this.judicialAlertsService.listStudentAlerts(
      studentId,
      Boolean(query.incluir_inactivas),
    );
  }

  @Post("verify")
  @HttpCode(HttpStatus.OK)
  @Roles(...JUDICIAL_ALERT_VERIFY_ROLES)
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary:
      "Consultar de forma determinista por blind index si un receptor tiene alerta judicial bloqueante para un menor (RF-09)",
  })
  @ApiResponse({
    status: 200,
    description:
      "Resultado determinista: ALERTA_JUDICIAL_BLOQUEANTE o SIN_RESTRICCION_JUDICIAL sin exponer PII descifrada.",
  })
  @ApiResponse({
    status: 400,
    description: "Documento o documento_restringido_hash ausente o inconsistente.",
  })
  async verifyRestriction(
    @Body() dto: VerifyJudicialAlertDto,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    return this.judicialAlertsService.verifyRestriction(
      dto,
      user?.id_usuario ?? null,
    );
  }

  @Patch(":alertId/deactivate")
  @Roles(...JUDICIAL_ALERT_MANAGE_ROLES)
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary:
      "Desactivar (soft-delete auditable) una alerta judicial por levantamiento oficial de medida cautelar",
  })
  @ApiParam({ name: "alertId", description: "UUID de la alerta judicial" })
  @ApiResponse({
    status: 200,
    description: "Alerta judicial marcada como inactiva (eliminado_soft = true).",
  })
  @ApiResponse({ status: 404, description: "Alerta judicial no encontrada." })
  @ApiResponse({ status: 409, description: "La alerta ya estaba desactivada." })
  async deactivateAlert(
    @Param("alertId", ParseUUIDv7Pipe) alertId: string,
    @Body() dto: DeactivateJudicialAlertDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.judicialAlertsService.deactivateAlert(
      alertId,
      dto,
      user.id_usuario,
    );
  }
}
