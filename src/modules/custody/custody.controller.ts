import { Controller, Post, Body, Param, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { CustodyService } from './custody.service';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { RoleEnum } from '@common/enums/role.enum';
import { ParseUUIDv7Pipe } from '@common/pipes/parse-uuidv7.pipe';

@ApiTags('Custodia, Adultos Autorizados y Restricciones Judiciales (Custody)')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('custody')
export class CustodyController {
  constructor(private readonly custodyService: CustodyService) {}

  @Post('verify-receptor/:studentId')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleEnum.MONITOR, RoleEnum.MONITORA, RoleEnum.SUPER_ADMIN, RoleEnum.SCHOOL_COORDINATOR)
  @ApiOperation({ summary: 'Validar identidad y vigencia de orden judicial del receptor en parada (RF-06)' })
  async verifyReceptor(
    @Param('studentId', ParseUUIDv7Pipe) studentId: string,
    @Body('documento') documento: string,
  ) {
    return this.custodyService.verifyReceptor(studentId, documento);
  }

  @Post('failed-delivery/:studentId')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleEnum.MONITOR, RoleEnum.MONITORA, RoleEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Activar protocolo de Desembarque Fallido y Retorno Seguro a Sede Escolar (RF-08)' })
  async failedDelivery(
    @Param('studentId', ParseUUIDv7Pipe) studentId: string,
    @Body('motivo') motivo: string,
    @Body('id_viaje', ParseUUIDv7Pipe) id_viaje: string,
  ) {
    return this.custodyService.triggerFailedDeliveryProtocol(studentId, motivo, id_viaje);
  }
}
