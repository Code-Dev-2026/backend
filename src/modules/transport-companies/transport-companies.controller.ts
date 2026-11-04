import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { TransportCompaniesService } from './transport-companies.service';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { RoleEnum } from '@common/enums/role.enum';
import { ParseUUIDv7Pipe } from '@common/pipes/parse-uuidv7.pipe';

@ApiTags('Empresas de Transporte y Flota Homologada (Transport Companies)')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('transport-companies')
export class TransportCompaniesController {
  constructor(private readonly transportService: TransportCompaniesService) {}

  @Get('current')
  @Roles(RoleEnum.SUPER_ADMIN, RoleEnum.TRANSPORT_ADMIN, RoleEnum.GERENCIA_TRANSPORTE, RoleEnum.JEFE_OPERACIONES)
  @ApiOperation({ summary: 'Obtener datos de la empresa operadora (Transportes Camino Seguro S.A.S.)' })
  async getCurrentCompany() {
    return this.transportService.getCompanyInfo();
  }

  @Get('vehicles')
  @Roles(RoleEnum.SUPER_ADMIN, RoleEnum.TRANSPORT_ADMIN, RoleEnum.SCHOOL_COORDINATOR, RoleEnum.MONITOR)
  @ApiOperation({ summary: 'Listar la flota de vehículos homologados con capacidad nominal' })
  async getFleet() {
    return this.transportService.getFleet();
  }

  @Get('vehicles/:id')
  @Roles(RoleEnum.SUPER_ADMIN, RoleEnum.TRANSPORT_ADMIN, RoleEnum.MONITOR)
  @ApiOperation({ summary: 'Consultar especificaciones y vigencias de un vehículo por UUID' })
  async getVehicle(@Param('id', ParseUUIDv7Pipe) id: string) {
    return this.transportService.getVehicleById(id);
  }
}
