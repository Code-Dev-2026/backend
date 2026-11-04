import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { RoutesService } from './routes.service';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { RoleEnum } from '@common/enums/role.enum';
import { ParseUUIDv7Pipe } from '@common/pipes/parse-uuidv7.pipe';

@ApiTags('Rutas Viales y Georreferenciación PostGIS (Routes & Geospatial)')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('routes')
export class RoutesController {
  constructor(private readonly routesService: RoutesService) {}

  @Get(':id')
  @Roles(RoleEnum.SUPER_ADMIN, RoleEnum.TRANSPORT_ADMIN, RoleEnum.SCHOOL_COORDINATOR, RoleEnum.MONITOR, RoleEnum.DRIVER)
  @ApiOperation({ summary: 'Obtener trazado oficial de ruta, secuencias de paradas y geocercas ETA (SRID 4326)' })
  async getRoute(@Param('id', ParseUUIDv7Pipe) id: string) {
    return this.routesService.getRouteDetails(id);
  }
}
