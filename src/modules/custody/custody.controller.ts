import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Optional,
  Param,
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
import { CustodyTransitionNotifier } from "../notifications/custody-transition.notifier";
import { CustodyService } from "./custody.service";
import {
  EnrollStudentTripDto,
  HistoryLimitQueryDto,
  InitializeMorningCustodyDto,
  TransitionCustodyDto,
  VerifyIntegrityQueryDto,
} from "./dto/custody.dto";

const CUSTODY_OPERATOR_ROLES = [
  RoleEnum.ADMIN,
  RoleEnum.COORDINADORA_CONVIVENCIA,
  RoleEnum.JEFE_OPERACIONES,
  RoleEnum.MONITORA,
] as const;

const CUSTODY_ADMIN_ROLES = [
  RoleEnum.ADMIN,
  RoleEnum.COORDINADORA_CONVIVENCIA,
  RoleEnum.RECTORIA,
  RoleEnum.JEFE_OPERACIONES,
] as const;

const CUSTODY_READ_ROLES = [
  ...CUSTODY_ADMIN_ROLES,
  RoleEnum.GERENCIA_TRANSPORTE,
  RoleEnum.MONITORA,
  RoleEnum.CONDUCTOR,
] as const;

@ApiTags("Cadena de Custodia Física y FSM (Sprint 2)")
@ApiBearerAuth()
@Controller("custody")
export class CustodyController {
  private readonly logger = new Logger(CustodyController.name);

  constructor(
    private readonly custodyService: CustodyService,
    /** Issue #15: notificación en tiempo real de cada transición aplicada. */
    @Optional()
    private readonly transitionNotifier?: CustodyTransitionNotifier,
  ) {}

  @Post("transitions")
  @Roles(...CUSTODY_OPERATOR_ROLES)
  @ApiOperation({
    summary:
      "Ejecutar transición de custodia validada por la FSM y registrar evento encadenado SHA-256 WORM (RF-06, RN-01, RNF-01)",
  })
  @ApiResponse({
    status: 201,
    description:
      "Transición aplicada en viaje_estudiante y registrada inmutablemente en historial_estado_custodia.",
  })
  @ApiResponse({
    status: 400,
    description: "Payload o coordenadas WGS84 inválidas.",
  })
  @ApiResponse({
    status: 404,
    description: "El estudiante no está matriculado en el viaje.",
  })
  @ApiResponse({
    status: 422,
    description:
      "Violación de invariante FSM: transición no permitida para el estado o recorrido.",
  })
  async executeTransition(
    @Body() dto: TransitionCustodyDto,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    const result = await this.custodyService.executeTransition({
      id_viaje: dto.id_viaje,
      id_estudiante: dto.id_estudiante,
      estado_destino: dto.estado_destino,
      tipo_recorrido: dto.tipo_recorrido,
      disparador_evento: dto.disparador_evento,
      registrado_por_usuario: user?.id_usuario ?? null,
      latitud: dto.latitud,
      longitud: dto.longitud,
    });

    // Sin `await`: la notificación no retrasa la respuesta de la transición.
    if (this.transitionNotifier) {
      void this.transitionNotifier
        .notifyTransition(result.history)
        .catch((err: unknown) =>
          this.logger.error(
            `No se pudo notificar la transición ${result.history.id_historial}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }
    return result;
  }

  @Post("trips/:tripId/enroll")
  @Roles(...CUSTODY_ADMIN_ROLES)
  @ApiOperation({
    summary:
      "Inicializar matrícula operativa de un estudiante en un viaje en estado NO_INICIADO",
  })
  @ApiParam({ name: "tripId", description: "UUID del viaje" })
  @ApiResponse({
    status: 201,
    description: "Estudiante registrado en viaje_estudiante en estado NO_INICIADO.",
  })
  async enrollStudentInTrip(
    @Param("tripId", ParseUUIDv7Pipe) tripId: string,
    @Body() dto: EnrollStudentTripDto,
  ) {
    return this.custodyService.enrollStudentInTrip(
      tripId,
      dto.id_estudiante,
      dto.es_pasajero_ocasional ?? false,
    );
  }

  @Get("trips/:tripId/students")
  @Roles(...CUSTODY_READ_ROLES)
  @ApiOperation({
    summary: "Consultar estados actuales de custodia de todos los estudiantes del viaje",
  })
  @ApiParam({ name: "tripId", description: "UUID del viaje" })
  @ApiResponse({ status: 200, description: "Estados de custodia obtenidos." })
  async listTripCustody(@Param("tripId", ParseUUIDv7Pipe) tripId: string) {
    return this.custodyService.listTripCustody(tripId);
  }

  @Get("trips/:tripId/students/:studentId")
  @Roles(...CUSTODY_READ_ROLES)
  @ApiOperation({
    summary:
      "Consultar estado actual de custodia de un estudiante en un viaje y sus transiciones válidas",
  })
  @ApiParam({ name: "tripId", description: "UUID del viaje" })
  @ApiParam({ name: "studentId", description: "UUID del estudiante" })
  @ApiResponse({ status: 200, description: "Detalle de custodia obtenido." })
  @ApiResponse({ status: 404, description: "Matrícula en viaje no encontrada." })
  async getStudentTripCustody(
    @Param("tripId", ParseUUIDv7Pipe) tripId: string,
    @Param("studentId", ParseUUIDv7Pipe) studentId: string,
  ) {
    return this.custodyService.getStudentTripCustody(tripId, studentId);
  }

  @Get("trips/:tripId/history")
  @Roles(...CUSTODY_READ_ROLES)
  @ApiOperation({
    summary:
      "Consultar historial inmutable WORM encadenado SHA-256 de un viaje",
  })
  @ApiParam({ name: "tripId", description: "UUID del viaje" })
  @ApiResponse({ status: 200, description: "Historial forense obtenido." })
  async getTripCustodyHistory(
    @Param("tripId", ParseUUIDv7Pipe) tripId: string,
  ) {
    return this.custodyService.getTripCustodyHistory(tripId);
  }

  @Get("students/:studentId/history")
  @Roles(...CUSTODY_READ_ROLES)
  @ApiOperation({
    summary:
      "Consultar historial inmutable WORM encadenado SHA-256 de un estudiante",
  })
  @ApiParam({ name: "studentId", description: "UUID del estudiante" })
  @ApiResponse({ status: 200, description: "Historial forense obtenido." })
  async getStudentCustodyHistory(
    @Param("studentId", ParseUUIDv7Pipe) studentId: string,
    @Query() query: HistoryLimitQueryDto,
  ) {
    return this.custodyService.getStudentCustodyHistory(
      studentId,
      query.limite,
    );
  }

  @Get("integrity/verify")
  @Roles(...CUSTODY_ADMIN_ROLES)
  @ApiOperation({
    summary:
      "Verificar criptográficamente la integridad de la cadena SHA-256 WORM en historial_estado_custodia (ASVS V1.14)",
  })
  @ApiResponse({
    status: 200,
    description: "Reporte de verificación criptográfica de la cadena.",
  })
  async verifyWormIntegrity(@Query() query: VerifyIntegrityQueryDto) {
    return this.custodyService.verifyWormChainIntegrity(query.limite);
  }

  @Post("jobs/morning-init")
  @Roles(...CUSTODY_ADMIN_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Ejecutar manualmente el job de inicialización matutina idempotente de custodia (NO_INICIADO)",
  })
  @ApiResponse({
    status: 200,
    description: "Resumen de inicialización matutina ejecutada.",
  })
  async runMorningInitialization(@Body() dto: InitializeMorningCustodyDto) {
    return this.custodyService.runMorningInitialization(dto.fecha);
  }

  // --------------------------------------------------------------------------
  // ENDPOINTS HEREDADOS (compatibilidad hasta Issue #9)
  // --------------------------------------------------------------------------

  @Post("verify-receptor")
  @Roles(...CUSTODY_OPERATOR_ROLES)
  @ApiOperation({
    summary:
      "Validar legitimación del receptor en parada frente a alertas judiciales (RF-06, RF-07)",
  })
  @ApiResponse({ status: 200, description: "Receptor validado." })
  @ApiResponse({
    status: 403,
    description: "Alerta judicial activa: Bloqueo exclusivo de entrega.",
  })
  async verifyReceptor(
    @Body("id_estudiante") id_estudiante: string,
    @Body("documento_receptor") documento_receptor: string,
  ) {
    return this.custodyService.verifyReceptor(
      id_estudiante,
      documento_receptor,
    );
  }

  @Post("failed-delivery")
  @Roles(...CUSTODY_OPERATOR_ROLES)
  @ApiOperation({
    summary: "Activar protocolo de retorno seguro a sede escolar (RF-08)",
  })
  async triggerFailedDelivery(
    @Body("id_estudiante") id_estudiante: string,
    @Body("motivo") motivo: string,
    @Body("id_viaje") id_viaje: string,
  ) {
    return this.custodyService.triggerFailedDeliveryProtocol(
      id_estudiante,
      motivo,
      id_viaje,
    );
  }
}
