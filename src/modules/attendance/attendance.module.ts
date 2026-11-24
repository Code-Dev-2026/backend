import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuditModule } from "../audit/audit.module";
import { CustodyModule } from "../custody/custody.module";
import { CustodyService } from "../custody/custody.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { AttendanceController } from "./attendance.controller";
import { AttendanceService } from "./attendance.service";
import { BoardingNotificationQueueService } from "./boarding-notification-queue.service";
import { CapacityEnforcer } from "./capacity-enforcer.service";
import { DeliveryValidationService } from "./delivery-validation.service";
import { DisembarkUseCase } from "./disembark.use-case";
import { ATTENDANCE_REALTIME_PORT } from "./domain/attendance-realtime.port";
import { ATTENDANCE_REPOSITORY } from "./domain/attendance-repository.port";
import { IncidentLogger } from "./incident-logger.service";
import { AttendanceRealtimeGateway } from "./infrastructure/attendance-realtime.gateway";
import { InMemoryAttendanceRepository } from "./infrastructure/in-memory-attendance.repository";
import { PostgresAttendanceRepository } from "./infrastructure/postgres-attendance.repository";
import { QrTokenValidator } from "./qr-token-validator.service";

@Module({
  imports: [AuditModule, CustodyModule, NotificationsModule],
  controllers: [AttendanceController],
  providers: [
    QrTokenValidator,
    CapacityEnforcer,
    {
      provide: ATTENDANCE_REPOSITORY,
      inject: [ConfigService, CapacityEnforcer, CustodyService],
      useFactory: (
        config: ConfigService,
        capacityEnforcer: CapacityEnforcer,
        custodyService: CustodyService,
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
    DisembarkUseCase,
    AttendanceService,
  ],
  exports: [
    AttendanceService,
    DeliveryValidationService,
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
