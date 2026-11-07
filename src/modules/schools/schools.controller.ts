import { Controller, Get, Param } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { SchoolsService } from "./schools.service";

@ApiTags("Instituciones Educativas (Sprint 1)")
@Controller("schools")
export class SchoolsController {
  constructor(private readonly schoolsService: SchoolsService) {}

  @Get("san-benito")
  @ApiOperation({
    summary:
      "Obtener información institucional del Colegio San Benito del Otún",
  })
  @ApiResponse({ status: 200, description: "Datos del colegio obtenidos." })
  async getSanBenito() {
    return this.schoolsService.getSanBenitoInfo();
  }

  @Get(":id")
  @ApiOperation({ summary: "Consultar colegio por ID" })
  async getById(@Param("id") id: string) {
    return this.schoolsService.findById(id);
  }
}
