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
import { DisembarkUseCase } from "./disembark.use-case";
import { RegisterBoardingDto } from "./dto/register-boarding.dto";
import {
  FinalizeSchoolCustodyDto,
  RegisterDisembarkDto,
} from "./dto/register-disembark.dto";

const BOARDING_ALLOWED_ROLES = [
  RoleEnum.MONITORA,
  RoleEnum.ADMIN,
  RoleEnum.COORDINADORA_CONVIVENCIA,
  RoleEnum.JEFE_OPERACIONES,
] as const;

const SCHOOL_CUSTODY_FINALIZE_ROLES = [
  RoleEnum.COORDINADORA_CONVIVENCIA,
  RoleEnum.RECTORIA,
  RoleEnum.ADMIN,
  RoleEnum.JEFE_OPERACIONES,
] as const;

@ApiTags("Control de Asistencia, Aforo QR y Desembarque Seguro (Sprint 2)")
@ApiBearerAuth()
@Controller("asistencia")
export class AttendanceController {
  constructor(
    private readonly attendanceService: AttendanceService,
    private readonly disembarkUseCase: DisembarkUseCase,
  ) {}

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

  @Post("descenso")
  @HttpCode(HttpStatus.OK)
  @Roles(...BOARDING_ALLOWED_ROLES)
  @ApiOperation({
    summary:
      "Registrar desembarque seguro con validación de receptor o protocolo de retorno a sede escolar (RF-09, RF-11, RN-04, ASVS V4.1)",
  })
  @ApiHeader({
    name: "X-Idempotency-Key",
    required: false,
    description:
      "Clave idempotente opcional para evitar entregas duplicadas o doble decremento de aforo",
  })
  @ApiResponse({
    status: 200,
    description:
      "Resultado estructurado: DESCENSO_EXITOSO o DESEMBARQUE_FALLIDO_RETORNO (sin decrementar total_a_bordo).",
  })
  @ApiResponse({
    status: 400,
    description: "Payload, tipo_receptor o coordenadas WGS84 inválidas.",
  })
  @ApiResponse({
    status: 401,
    description: "Token JWT requerido o inválido.",
  })
  @ApiResponse({
    status: 403,
    description:
      "Rol sin permiso, alerta judicial bloqueante (ALERTA_JUDICIAL_BLOQUEANTE), receptor no autorizado, inactivo/revocado o autorización vencida.",
  })
  @ApiResponse({
    status: 404,
    description: "Viaje o estudiante no encontrado.",
  })
  @ApiResponse({
    status: 409,
    description:
      "Viaje no EN_CURSO o descenso previo ya registrado para el estudiante.",
  })
  @ApiResponse({
    status: 422,
    description:
      "Estudiante no A_BORDO_VEHICULO, recorrido incompatible o violación RN-04 (> 3 autorizados activos).",
  })
  async registerDisembark(
    @Body() dto: RegisterDisembarkDto,
    @CurrentUser() user?: AuthenticatedUser,
    @IdempotencyKey(false) headerIdempotencyKey?: string,
  ) {
    return this.disembarkUseCase.executeDisembark({
      id_viaje: dto.id_viaje,
      id_estudiante: dto.id_estudiante,
      resultado_entrega: dto.resultado_entrega,
      tipo_receptor: dto.tipo_receptor ?? null,
      documento_receptor: dto.documento_receptor ?? null,
      documento_blind_index: dto.documento_blind_index ?? null,
      id_receptor: dto.id_receptor ?? null,
      metodo_validacion: dto.metodo_validacion,
      coordenadas_gps: dto.coordenadas_gps,
      foto_evidencia_url: dto.foto_evidencia_url ?? null,
      observaciones_fallido: dto.observaciones_fallido ?? null,
      sincronizado_offline: dto.sincronizado_offline,
      idempotency_key: headerIdempotencyKey ?? dto.idempotency_key ?? null,
      registrado_por_usuario: user?.id_usuario ?? null,
    });
  }

  @Post("custodia/finalizar-sede")
  @HttpCode(HttpStatus.OK)
  @Roles(...SCHOOL_CUSTODY_FINALIZE_ROLES)
  @ApiOperation({
    summary:
      "Cerrar formalmente la custodia en sede escolar tras retorno por falla de entrega (RF-11, ASVS V4.1)",
  })
  @ApiHeader({
    name: "X-Idempotency-Key",
    required: false,
    description: "Clave idempotente opcional para el cierre formal en sede",
  })
  @ApiResponse({
    status: 200,
    description:
      "Custodia certificada en sede con acta_custodia firmada SHA-256, decremento de total_a_bordo y estado EN_COLEGIO.",
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
    description:
      "Rol sin potestad institucional (separación de funciones) o coordinador no perteneciente al colegio.",
  })
  @ApiResponse({
    status: 404,
    description: "Viaje o estudiante no encontrado.",
  })
  @ApiResponse({
    status: 409,
    description:
      "Viaje no EN_CURSO, sin entrega fallida previa o acta de custodia ya emitida.",
  })
  @ApiResponse({
    status: 422,
    description:
      "Estudiante no se encuentra en estado RETORNO_SEDE_POR_FALLA_ENTREGA.",
  })
  async finalizeSchoolCustody(
    @Body() dto: FinalizeSchoolCustodyDto,
    @CurrentUser() user?: AuthenticatedUser,
    @IdempotencyKey(false) headerIdempotencyKey?: string,
  ) {
    return this.disembarkUseCase.finalizeSchoolCustody({
      id_viaje: dto.id_viaje,
      id_estudiante: dto.id_estudiante,
      recibido_por_coordinador: dto.recibido_por_coordinador,
      coordenadas_gps: dto.coordenadas_gps,
      observaciones: dto.observaciones ?? null,
      idempotency_key: headerIdempotencyKey ?? dto.idempotency_key ?? null,
      registrado_por_usuario: user?.id_usuario ?? null,
    });
  }
}
