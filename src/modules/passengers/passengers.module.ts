import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AttendanceModule } from "../attendance/attendance.module";
import {
  ATTENDANCE_REPOSITORY,
  IAttendanceRepository,
} from "../attendance/domain/attendance-repository.port";
import { AuditModule } from "../audit/audit.module";
import { CustodyModule } from "../custody/custody.module";
import { CustodyService } from "../custody/custody.service";
import { OCCASIONAL_PASSENGER_REPOSITORY } from "./domain/occasional-passenger-repository.port";
import { InMemoryOccasionalPassengerRepository } from "./infrastructure/in-memory-occasional-passenger.repository";
import { PostgresOccasionalPassengerRepository } from "./infrastructure/postgres-occasional-passenger.repository";
import {
  OccasionalBookingService,
  PASSENGERS_CLOCK,
} from "./occasional-booking.service";
import { PassengerCapacityEvaluator } from "./passenger-capacity-evaluator.service";
import { PassengersController } from "./passengers.controller";

@Module({
  imports: [AuditModule, CustodyModule, AttendanceModule],
  controllers: [PassengersController],
  providers: [
    PassengerCapacityEvaluator,
    {
      provide: PASSENGERS_CLOCK,
      useValue: () => new Date(),
    },
    {
      provide: OCCASIONAL_PASSENGER_REPOSITORY,
      inject: [
        ConfigService,
        PassengerCapacityEvaluator,
        CustodyService,
        ATTENDANCE_REPOSITORY,
      ],
      useFactory: (
        config: ConfigService,
        capacityEvaluator: PassengerCapacityEvaluator,
        custodyService: CustodyService,
        attendanceRepository: IAttendanceRepository,
      ) => {
        const usePostgres =
          config.get<string>("PASSENGERS_USE_POSTGRES") === "true";
        if (usePostgres) {
          return PostgresOccasionalPassengerRepository.fromConfig({
            host: config.get<string>("DB_HOST", "localhost"),
            port: config.get<number>("DB_PORT", 5432),
            database: config.get<string>("DB_NAME", "camino_seguro_db"),
            user: config.get<string>("DB_USER", "app_user"),
            password: config.get<string>("DB_PASSWORD"),
          });
        }
        return new InMemoryOccasionalPassengerRepository(
          capacityEvaluator,
          custodyService,
          attendanceRepository,
        );
      },
    },
    OccasionalBookingService,
  ],
  exports: [
    PassengerCapacityEvaluator,
    OccasionalBookingService,
    OCCASIONAL_PASSENGER_REPOSITORY,
  ],
})
export class PassengersModule {}
