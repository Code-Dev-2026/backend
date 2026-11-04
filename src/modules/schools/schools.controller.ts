import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { SchoolsService } from './schools.service';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { RoleEnum } from '@common/enums/role.enum';
import { ParseUUIDv7Pipe } from '@common/pipes/parse-uuidv7.pipe';

@ApiTags('Colegios e Instituciones (Schools)')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('schools')
export class SchoolsController {
  constructor(private readonly schoolsService: SchoolsService) {}

  @Get('current')
  @Roles(RoleEnum.SUPER_ADMIN, RoleEnum.SCHOOL_COORDINATOR, RoleEnum.COORDINADORA_CONVIVENCIA, RoleEnum.RECTORIA)
  @ApiOperation({ summary: 'Obtener información de la institución educativa contratante (Colegio San Benito del Otún)' })
  @ApiResponse({ status: 200, description: 'Datos del colegio recuperados exitosamente' })
  async getCurrentSchool() {
    return this.schoolsService.getSanBenitoInfo();
  }

  @Get(':id')
  @Roles(RoleEnum.SUPER_ADMIN, RoleEnum.SCHOOL_COORDINATOR)
  @ApiOperation({ summary: 'Consultar institución por UUID' })
  async getById(@Param('id', ParseUUIDv7Pipe) id: string) {
    return this.schoolsService.findById(id);
  }
}
