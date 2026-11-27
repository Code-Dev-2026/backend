import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CustodyTransitionNotifier } from "./custody-transition.notifier";
import {
  DEFAULT_NOTIFICATION_DISPATCH_OPTIONS,
  NOTIFICATION_DISPATCH_OPTIONS,
  NOTIFICATION_RECIPIENT_DIRECTORY,
  NOTIFICATION_REPOSITORY,
} from "./domain/notification-dispatch.ports";
import { InMemoryNotificationRepository } from "./infrastructure/in-memory-notification.repository";
import {
  InMemoryNotificationRecipientDirectory,
  PostgresNotificationRecipientDirectory,
} from "./infrastructure/notification-recipient.directory";
import { PostgresNotificationRepository } from "./infrastructure/postgres-notification.repository";
import { NotificationChannelRegistry } from "./notification-channel.registry";
import { NotificationDispatcherService } from "./notification-dispatcher.service";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";

const pgConfig = (config: ConfigService) => ({
  host: config.get<string>("DB_HOST", "localhost"),
  port: config.get<number>("DB_PORT", 5432),
  database: config.get<string>("DB_NAME", "camino_seguro_db"),
  user: config.get<string>("DB_USER", "app_user"),
  password: config.get<string>("DB_PASSWORD"),
});

const usePostgres = (config: ConfigService) =>
  config.get<string>("NOTIFICATIONS_USE_POSTGRES") === "true";

/**
 * Notificaciones (Sprint 2 + Issue #15). El despachador en tiempo real no depende de
 * ningún transporte: los canales (p. ej. Socket.IO en `RealtimeModule`) se registran
 * en `NotificationChannelRegistry`.
 */
@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationChannelRegistry,
    {
      provide: NOTIFICATION_DISPATCH_OPTIONS,
      useValue: DEFAULT_NOTIFICATION_DISPATCH_OPTIONS,
    },
    {
      provide: NOTIFICATION_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        usePostgres(config)
          ? PostgresNotificationRepository.fromConfig(pgConfig(config))
          : new InMemoryNotificationRepository(),
    },
    {
      provide: NOTIFICATION_RECIPIENT_DIRECTORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        usePostgres(config)
          ? PostgresNotificationRecipientDirectory.fromConfig(pgConfig(config))
          : new InMemoryNotificationRecipientDirectory(),
    },
    NotificationDispatcherService,
    CustodyTransitionNotifier,
  ],
  exports: [
    NotificationsService,
    NotificationChannelRegistry,
    NotificationDispatcherService,
    CustodyTransitionNotifier,
    NOTIFICATION_REPOSITORY,
    NOTIFICATION_RECIPIENT_DIRECTORY,
    NOTIFICATION_DISPATCH_OPTIONS,
  ],
})
export class NotificationsModule {}
