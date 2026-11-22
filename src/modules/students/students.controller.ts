import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from "@nestjs/common";
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
import { ParseUUIDv7Pipe } from "@common/pipes/parse-uuidv7.pipe";
import {
  CreateStudentDto,
  ListStudentsQueryDto,
  SearchStudentByDocumentDto,
} from "./dto/student.dto";
import { StudentsService } from "./students.service";

/**
 * Expedientes de estudiantes. Todo el controlador exige rol administrativo
 * (ADMIN = coordinadora de convivencia / superadmin, o RECTORIA); el
 * JwtAuthGuard y el MfaGuard globales exigen además sesión con OTP.
 * Las respuestas llevan Cache-Control: no-store (datos de menores).
 */
@ApiTags("Expedientes de Estudiantes")
@ApiBearerAuth()
@Roles(RoleEnum.ADMIN, RoleEnum.RECTORIA)
@Controller("students")
export class StudentsController {
  constructor(private readonly studentsService: StudentsService) {}

  @Post()
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary: "Registrar un estudiante (datos cifrados en reposo)",
  })
  @ApiResponse({ status: 201, description: "Expediente creado." })
  @ApiResponse({ status: 409, description: "Documento o código duplicado." })
  create(
    @Body() dto: CreateStudentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.studentsService.create(dto, user);
  }

  @Get()
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary: "Listar estudiantes (sin documento, dirección ni datos médicos)",
  })
  list(
    @Query() query: ListStudentsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.studentsService.list(query.offset, query.limit, user);
  }

  @Post("search")
  @HttpCode(HttpStatus.OK)
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary:
      "Buscar expediente por documento (índice ciego HMAC-SHA256; el documento va en el cuerpo)",
  })
  @ApiResponse({ status: 200, description: "Expediente encontrado." })
  @ApiResponse({ status: 404, description: "Sin coincidencias." })
  findByDocument(
    @Body() dto: SearchStudentByDocumentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.studentsService.findByDocument(dto.documento, user);
  }

  @Get(":id")
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Consultar expediente descifrado en memoria" })
  @ApiResponse({ status: 200, description: "Expediente descifrado." })
  @ApiResponse({ status: 404, description: "Estudiante no encontrado." })
  getStudent(
    @Param("id", ParseUUIDv7Pipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.studentsService.getExpediente(id, user);
  }
}
