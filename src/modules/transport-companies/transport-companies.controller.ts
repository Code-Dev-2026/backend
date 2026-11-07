import { Controller, Get, Param } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { TransportCompaniesService } from "./transport-companies.service";

@ApiTags("Empresas Transportadoras y Flota (Sprint 1)")
@Controller("transport-companies")
export class TransportCompaniesController {
  constructor(
    private readonly transportCompaniesService: TransportCompaniesService,
  ) {}

  @Get("info")
  @ApiOperation({
    summary:
      "Consultar información legal y operativa de la empresa transportadora",
  })
  async getCompanyInfo() {
    return this.transportCompaniesService.getCompanyInfo();
  }

  @Get("fleet")
  @ApiOperation({
    summary:
      "Listar flota vehicular homologada con cupo nominal estricto (RN-02)",
  })
  async getFleet() {
    return this.transportCompaniesService.getFleet();
  }

  @Get("fleet/:id")
  @ApiOperation({ summary: "Consultar vehículo específico por ID" })
  async getVehicle(@Param("id") id: string) {
    return this.transportCompaniesService.getVehicleById(id);
  }
}
