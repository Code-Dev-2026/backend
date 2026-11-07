import { Controller, Get, Param } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { StudentsService } from "./students.service";
import { ParseUUIDv7Pipe } from "@common/pipes/parse-uuidv7.pipe";

@ApiTags("Expedientes de Estudiantes (Sprint 1)")
@Controller("students")
export class StudentsController {
  constructor(private readonly studentsService: StudentsService) {}

  @Get(":id")
  @ApiOperation({
    summary:
      "Obtener expediente de estudiante con descifrado transparente (AES-256-GCM)",
  })
  @ApiResponse({
    status: 200,
    description: "Expediente descifrado exitosamente.",
  })
  @ApiResponse({ status: 404, description: "Estudiante no encontrado." })
  async getStudent(@Param("id", ParseUUIDv7Pipe) id: string) {
    return this.studentsService.getStudentById(id);
  }

  @Get("search/by-document/:documento")
  @ApiOperation({
    summary: "Búsqueda por Blind Indexing sin exponer datos en memoria",
  })
  @ApiResponse({ status: 200, description: "Búsqueda completada." })
  async findByDocument(@Param("documento") documento: string) {
    return this.studentsService.findByDocument(documento);
  }
}
