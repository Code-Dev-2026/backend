import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import {
  DEFAULT_NOTIFICATION_DISPATCH_OPTIONS,
  INotificationChannelPort,
  NOTIFICATION_DISPATCH_OPTIONS,
  NotificationDispatchOptions,
} from "../../notifications/domain/notification-dispatch.ports";
import {
  ChannelDeliveryResult,
  OutboundNotification,
} from "../../notifications/domain/notification-dispatch.types";
import { NotificationChannelRegistry } from "../../notifications/notification-channel.registry";
import { familyRoom, SERVER_EVENTS } from "../domain/realtime.constants";
import { TelemetryGateway } from "../telemetry.gateway";

export const FAMILY_ROOM_CHANNEL_NAME = "SOCKET_IO_SALA_FAMILIAR";

/**
 * Canal Socket.IO de notificaciones hacia la sala familiar del acudiente (Issue #15).
 *
 * - Solo emite a `familia:{id_acudiente}`, sala a la que únicamente entran los sockets
 *   autenticados por JWT cuyo `id_usuario` corresponde a ese acudiente (Issue #14).
 * - Exige confirmación (ack) del cliente dentro de `ackTimeoutMs`; sin ack el
 *   despachador reintenta.
 */
@Injectable()
export class FamilyRoomNotificationChannel
  implements INotificationChannelPort, OnModuleInit, OnModuleDestroy
{
  readonly name = FAMILY_ROOM_CHANNEL_NAME;
  private readonly ackTimeoutMs: number;

  constructor(
    private readonly gateway: TelemetryGateway,
    private readonly registry: NotificationChannelRegistry,
    @Optional()
    @Inject(NOTIFICATION_DISPATCH_OPTIONS)
    options?: Partial<NotificationDispatchOptions>,
  ) {
    this.ackTimeoutMs =
      options?.ackTimeoutMs ??
      DEFAULT_NOTIFICATION_DISPATCH_OPTIONS.ackTimeoutMs;
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  onModuleDestroy(): void {
    this.registry.unregister(this.name);
  }

  async deliver(
    notification: OutboundNotification,
  ): Promise<ChannelDeliveryResult> {
    const server = this.gateway.server;
    const room = familyRoom(notification.id_acudiente);
    const connected = server?.adapter.rooms.get(room)?.size ?? 0;
    if (!server || connected === 0) {
      return {
        channel: this.name,
        status: "NO_RECIPIENT",
        detail: "SIN_SESION_ACTIVA",
      };
    }

    const acks = await new Promise<unknown[]>((resolve) => {
      server
        .to(room)
        .timeout(this.ackTimeoutMs)
        .emit(
          SERVER_EVENTS.NOTIFICATION,
          notification,
          (_err: Error | null, responses: unknown[]) =>
            resolve(Array.isArray(responses) ? responses : []),
        );
    });

    return acks.length > 0
      ? { channel: this.name, status: "DELIVERED" }
      : {
          channel: this.name,
          status: "SENT_UNCONFIRMED",
          detail: "SIN_CONFIRMACION_ACK",
        };
  }
}
