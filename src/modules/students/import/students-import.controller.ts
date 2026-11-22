import {
  Body,
  Controller,
  Header,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Response } from "express";
import {
  AuthenticatedUser,
  CurrentUser,
} from "@common/decorators/current-user.decorator";
import { Roles } from "@common/decorators/roles.decorator";
import { RoleEnum } from "@common/enums/role.enum";
import { ImportStudentsDto } from "../dto/student.dto";
import {
  EnrollmentImportService,
  IMPORT_MAX_BYTES,
  ImportBalance,
  UploadedEnrollmentFile,
} from "./enrollment-import.service";

@ApiTags("Expedientes de Estudiantes")
@ApiBearerAuth()
@Roles(RoleEnum.ADMIN, RoleEnum.RECTORIA)
@Controller("students")
export class StudentsImportController {
  constructor(private readonly importService: EnrollmentImportService) {}

  @Post("import")
  @Header("Cache-Control", "no-store")
  @UseInterceptors(
    FileInterceptor("file", {
      // Almacenamiento en memoria (por defecto): el archivo nunca toca disco.
      // Multer corta la subida al superar el límite -> 413 Payload Too Large
      limits: { fileSize: IMPORT_MAX_BYTES, files: 1, fields: 5 },
    }),
  )
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["file", "id_colegio"],
      properties: {
        file: {
          type: "string",
          format: "binary",
          description:
            "CSV (UTF-8, separado por , o ;) o Excel .xlsx. Columnas: codigo_institucional, nombre_completo, documento_identidad, direccion, condiciones_medicas (opcional), grado.",
        },
        id_colegio: { type: "string", format: "uuid" },
      },
    },
  })
  @ApiOperation({
    summary:
      "Importación masiva de matrículas (transaccional, idempotente por SHA-256)",
  })
  @ApiResponse({ status: 201, description: "Importación confirmada." })
  @ApiResponse({ status: 409, description: "El archivo ya fue importado." })
  @ApiResponse({ status: 413, description: "El archivo supera 5 MB." })
  @ApiResponse({ status: 415, description: "Tipo de archivo no permitido." })
  @ApiResponse({
    status: 422,
    description: "Hubo errores: se hizo rollback y no se guardó ninguna fila.",
  })
  async import(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: ImportStudentsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ImportBalance> {
    const outcome = await this.importService.import(
      file as UploadedEnrollmentFile | undefined,
      dto.id_colegio,
      user,
    );
    res.status(outcome.httpStatus);
    return outcome.balance;
  }
}
