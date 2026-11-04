import { Controller, Post, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { TelemetryService, GpsPacketDto } from './telemetry.service';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { RoleEnum } from '@common/enums/role.enum';
import { IdempotencyKey } from '@common/decorators/idempotency-key.decorator';

@ApiTags('Telemetría GPS y Sincronización Offline (Telemetry & Sync)')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('telemetry')
export class TelemetryController {
  constructor(private readonly telemetryService: TelemetryService) {}

  @Post('gps')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(RoleEnum.DRIVER, RoleEnum.CONDUCTOR, RoleEnum.TRANSPORT_ADMIN, RoleEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Ingesta de paquete telemático GPS vehicular (con cálculo de desvío > 300m)' })
  async ingestGps(@Body() packet: GpsPacketDto) {
    return this.telemetryService.processGpsTelemetry(packet);
  }

  @Post('sync/offline-batch')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleEnum.MONITOR, RoleEnum.MONITORA, RoleEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Sincronizar lote FIFO de lecturas y eventos acumulados en zonas de sombra celular' })
  async syncBatch(
    @IdempotencyKey() idempotencyKey: string,
    @Body('id_dispositivo') id_dispositivo: string,
    @Body('events') events: unknown[],
  ) {
    return this.telemetryService.syncOfflineBatch(id_dispositivo, events || []);
  }
}
