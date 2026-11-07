import { Controller, Post, Body } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import {
  NotificationsService,
  PushNotificationPayload,
} from "./notifications.service";

@ApiTags("Despacho de Notificaciones (Sprint 3)")
@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post("push")
  @ApiOperation({
    summary:
      "Despachar notificación transaccional hacia acudientes (<2.5s SLA)",
  })
  @ApiResponse({ status: 200, description: "Notificación despachada." })
  async sendPush(@Body() payload: PushNotificationPayload) {
    return this.notificationsService.sendPushNotification(payload);
  }
}
