import { Injectable, Logger } from "@nestjs/common";
import { INotificationChannelPort } from "./domain/notification-dispatch.ports";

/**
 * Registro de canales de emisión (OCP — Issue #15).
 *
 * Cada canal se registra a sí mismo desde su módulo (p. ej. la sala familiar Socket.IO
 * de `RealtimeModule`), de modo que añadir un canal no modifica el despachador ni
 * crea dependencias circulares entre módulos.
 */
@Injectable()
export class NotificationChannelRegistry {
  private readonly logger = new Logger(NotificationChannelRegistry.name);
  private readonly channels = new Map<string, INotificationChannelPort>();

  register(channel: INotificationChannelPort): void {
    this.channels.set(channel.name, channel);
    this.logger.log(`Canal de notificación registrado: ${channel.name}`);
  }

  unregister(name: string): void {
    this.channels.delete(name);
  }

  list(): INotificationChannelPort[] {
    return Array.from(this.channels.values());
  }
}
