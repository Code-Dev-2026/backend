import { Controller, Post, Body } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { AuditService, AuditEventPayload } from "./audit.service";

@ApiTags("Auditoría Forense Inmutable WORM (Sprint 4)")
@Controller("audit")
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Post("event")
  @ApiOperation({
    summary:
      "Registrar evento crítico en el libro mayor forense encadenado por SHA-256",
  })
  @ApiResponse({
    status: 200,
    description: "Evento encadenado inmutablemente.",
  })
  async logEvent(@Body() payload: AuditEventPayload) {
    return this.auditService.logCriticalEvent(payload);
  }
}
