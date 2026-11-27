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
import { OfflineSyncBatchDto } from "./dto/offline-sync.dto";
import { OfflineSyncProcessor } from "./offline-sync.processor";

@ApiTags("Sincronización Offline Idempotente (Issue #16)")
@ApiBearerAuth()
@Controller("sync")
export class OfflineController {
  constructor(private readonly processor: OfflineSyncProcessor) {}

  @Post("offline")
  @HttpCode(HttpStatus.OK)
  @Roles(RoleEnum.MONITORA)
  @ApiOperation({
    summary:
      "Sincronizar un lote de abordajes/descensos capturados sin señal (RF-06, RF-08, RNF-04, ASVS V11.1)",
  })
  @ApiResponse({
    status: 200,
    description:
      "Reporte por operación (PROCESADO, CONFLICTO, DESCARTADO, ERROR_TRANSITORIO) con marca de duplicado.",
  })
  @ApiResponse({
    status: 400,
    description: "Lote o esquema de operación inválido.",
  })
  @ApiResponse({ status: 401, description: "Token JWT requerido o inválido." })
  @ApiResponse({
    status: 403,
    description:
      "Rol no MONITORA o dispositivo no registrado/inactivo/ajeno (DISPOSITIVO_NO_AUTORIZADO).",
  })
  async syncOffline(
    @Body() dto: OfflineSyncBatchDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.processor.processBatch(user, dto);
  }
}
