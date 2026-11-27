import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuditModule } from "../audit/audit.module";
import { CustodyModule } from "../custody/custody.module";
import { CustodyService } from "../custody/custody.service";
import {
  IJudicialAlertRepository,
  JUDICIAL_ALERT_REPOSITORY,
} from "../custody/judicial-alerts/domain/judicial-alert-repository.port";
import { NotificationsModule } from "../notifications/notifications.module";
import { AttendanceController } from "./attendance.controller";
import { AttendanceService } from "./attendance.service";
import { BoardingNotificationQueueService } from "./boarding-notification-queue.service";
import { CapacityEnforcer } from "./capacity-enforcer.service";
import { DeliveryValidationService } from "./delivery-validation.service";
import { DisembarkUseCase } from "./disembark.use-case";
import { ATTENDANCE_REALTIME_PORT } from "./domain/attendance-realtime.port";
import { ATTENDANCE_REPOSITORY } from "./domain/attendance-repository.port";
import {
  DELIVERY_INTERCEPTORS,
  DeliveryInterceptorChain,
} from "./domain/delivery-interceptor.interface";
import { IncidentLogger } from "./incident-logger.service";
import { AttendanceRealtimeGateway } from "./infrastructure/attendance-realtime.gateway";
import { InMemoryAttendanceRepository } from "./infrastructure/in-memory-attendance.repository";
import { PostgresAttendanceRepository } from "./infrastructure/postgres-attendance.repository";
import { JudicialAlertDeliveryInterceptor } from "./judicial-alert-delivery.interceptor";
import { QrTokenValidator } from "./qr-token-validator.service";

@Module({
  imports: [AuditModule, CustodyModule, NotificationsModule],
  controllers: [AttendanceController],
  providers: [
    QrTokenValidator,
    CapacityEnforcer,
    {
      provide: ATTENDANCE_REPOSITORY,
      inject: [
        ConfigService,
        CapacityEnforcer,
        CustodyService,
        JUDICIAL_ALERT_REPOSITORY,
      ],
      useFactory: (
        config: ConfigService,
        capacityEnforcer: CapacityEnforcer,
        custodyService: CustodyService,
        judicialAlertRepository: IJudicialAlertRepository,
      ) => {
        const usePostgres =
          config.get<string>("ATTENDANCE_USE_POSTGRES") === "true";
        if (usePostgres) {
          return PostgresAttendanceRepository.fromConfig({
            host: config.get<string>("DB_HOST", "localhost"),
            port: config.get<number>("DB_PORT", 5432),
            database: config.get<string>("DB_NAME", "camino_seguro_db"),
            user: config.get<string>("DB_USER", "app_user"),
            password: config.get<string>("DB_PASSWORD"),
          });
        }
        return new InMemoryAttendanceRepository(
          capacityEnforcer,
          custodyService,
          judicialAlertRepository,
        );
      },
    },
    AttendanceRealtimeGateway,
    {
      provide: ATTENDANCE_REALTIME_PORT,
      useExisting: AttendanceRealtimeGateway,
    },
    IncidentLogger,
    BoardingNotificationQueueService,
    DeliveryValidationService,
    JudicialAlertDeliveryInterceptor,
    {
      provide: DELIVERY_INTERCEPTORS,
      inject: [JudicialAlertDeliveryInterceptor],
      useFactory: (judicialInterceptor: JudicialAlertDeliveryInterceptor) => [
        judicialInterceptor,
      ],
    },
    DeliveryInterceptorChain,
    DisembarkUseCase,
    AttendanceService,
  ],
  exports: [
    AttendanceService,
    DeliveryValidationService,
    JudicialAlertDeliveryInterceptor,
    DeliveryInterceptorChain,
    DELIVERY_INTERCEPTORS,
    DisembarkUseCase,
    CapacityEnforcer,
    IncidentLogger,
    QrTokenValidator,
    BoardingNotificationQueueService,
    AttendanceRealtimeGateway,
    ATTENDANCE_REPOSITORY,
    ATTENDANCE_REALTIME_PORT,
  ],
})
export class AttendanceModule {}
