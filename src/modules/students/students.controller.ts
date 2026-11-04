import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { StudentsService } from './students.service';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { RoleEnum } from '@common/enums/role.enum';
import { ParseUUIDv7Pipe } from '@common/pipes/parse-uuidv7.pipe';

@ApiTags('Estudiantes y Bóveda Cifrada (Students & Habeas Data)')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('students')
export class StudentsController {
  constructor(private readonly studentsService: StudentsService) {}

  @Get('search-by-doc')
  @Roles(RoleEnum.SUPER_ADMIN, RoleEnum.SCHOOL_COORDINATOR, RoleEnum.RECTORIA)
  @ApiOperation({ summary: 'Búsqueda indexada sin exposición de datos mediante Blind Index HMAC-SHA256' })
  @ApiQuery({ name: 'documento', description: 'Número de documento a buscar' })
  async findByDocument(@Query('documento') documento: string) {
    return this.studentsService.findByDocument(documento);
  }

  @Get(':id')
  @Roles(RoleEnum.SUPER_ADMIN, RoleEnum.SCHOOL_COORDINATOR, RoleEnum.PARENT, RoleEnum.MONITOR)
  @ApiOperation({ summary: 'Consultar expediente de menor descifrado con autorización RBAC estricta' })
  async getStudentById(@Param('id', ParseUUIDv7Pipe) id: string) {
    return this.studentsService.getStudentById(id);
  }
}
