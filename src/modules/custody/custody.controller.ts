import { Controller, Post, Body } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { CustodyService } from "./custody.service";

@ApiTags("Cadena de Custodia Física y FSM (Sprint 2)")
@Controller("custody")
export class CustodyController {
  constructor(private readonly custodyService: CustodyService) {}

  @Post("verify-receptor")
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
