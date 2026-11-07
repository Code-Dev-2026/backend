import { Controller, Get, Param } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { BillingIsolationService } from "./billing-isolation.service";
import { ParseUUIDv7Pipe } from "@common/pipes/parse-uuidv7.pipe";

@ApiTags("Facturación y Segregación Financiera (Sprint 4)")
@Controller("billing-isolation")
export class BillingIsolationController {
  constructor(
    private readonly billingIsolationService: BillingIsolationService,
  ) {}

  @Get("student/:id/status")
  @ApiOperation({
    summary:
      "Consultar estado contable con inmunidad operativa estricta garantizada para el menor (RN-05)",
  })
  @ApiResponse({
    status: 200,
    description:
      "Estado contable consultado con inmunidad operativa confirmada.",
  })
  async getStudentBillingStatus(@Param("id", ParseUUIDv7Pipe) id: string) {
    return this.billingIsolationService.getStudentBillingStatus(id);
  }
}
