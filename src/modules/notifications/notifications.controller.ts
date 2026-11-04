import { Controller, Post, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { NotificationsService, PushNotificationPayload } from './notifications.service';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { RoleEnum } from '@common/enums/role.enum';

@ApiTags('Motor Transaccional de Notificaciones Push (Notifications)')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post('push')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(RoleEnum.SUPER_ADMIN, RoleEnum.SCHOOL_COORDINATOR, RoleEnum.TRANSPORT_ADMIN)
  @ApiOperation({ summary: 'Despachar alerta push instantánea con SLA inferior a 2.5s (RF-12, RF-20)' })
  async sendPush(@Body() payload: PushNotificationPayload) {
    return this.notificationsService.sendPushNotification(payload);
  }
}
