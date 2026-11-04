import { Controller, Post, Param, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { TripsService } from './trips.service';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { RoleEnum } from '@common/enums/role.enum';
import { ParseUUIDv7Pipe } from '@common/pipes/parse-uuidv7.pipe';

@ApiTags('Despacho y Ciclo de Vida de Viajes (Trips)')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('trips')
export class TripsController {
  constructor(private readonly tripsService: TripsService) {}

  @Post('start/:id')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleEnum.MONITOR, RoleEnum.MONITORA, RoleEnum.TRANSPORT_ADMIN, RoleEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Iniciar recorrido de viaje en ruta escolar (EN_CURSO)' })
  async startTrip(@Param('id', ParseUUIDv7Pipe) id: string) {
    return this.tripsService.startTrip(id);
  }

  @Post('finish/:id')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleEnum.MONITOR, RoleEnum.MONITORA, RoleEnum.TRANSPORT_ADMIN, RoleEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Finalizar recorrido oficial de viaje (COMPLETADO)' })
  async finishTrip(@Param('id', ParseUUIDv7Pipe) id: string) {
    return this.tripsService.finishTrip(id);
  }
}
