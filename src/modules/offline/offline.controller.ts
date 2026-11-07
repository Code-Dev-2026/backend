import { Controller, Post, Body } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { OfflineService, OfflineSyncBatchDto } from "./offline.service";

@ApiTags("Sincronización Offline e Idempotencia (Sprint 4)")
@Controller("offline")
export class OfflineController {
  constructor(private readonly offlineService: OfflineService) {}

  @Post("sync")
  @ApiOperation({
    summary: "Reconciliar cola offline desde terminales móviles de monitoras",
  })
  @ApiResponse({ status: 200, description: "Lote reconciliado exitosamente." })
  async syncBatch(@Body() dto: OfflineSyncBatchDto) {
    return this.offlineService.processOfflineBatch(dto);
  }
}
