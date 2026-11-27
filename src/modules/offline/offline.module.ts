import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AttendanceModule } from "../attendance/attendance.module";
import {
  DEVICE_REGISTRY,
  OFFLINE_OPERATION_HANDLERS,
  OFFLINE_SYNC_CLOCK,
  SYNC_OPERATION_REPOSITORY,
} from "./domain/offline-sync.ports";
import {
  BoardingOfflineHandler,
  DisembarkOfflineHandler,
} from "./handlers/offline-operation.handlers";
import {
  InMemoryDeviceRegistry,
  InMemorySyncOperationRepository,
} from "./infrastructure/in-memory-offline-sync.repositories";
import {
  PostgresDeviceRegistry,
  PostgresSyncOperationRepository,
} from "./infrastructure/postgres-offline-sync.repositories";
import { OfflineController } from "./offline.controller";
import { OfflineSyncProcessor } from "./offline-sync.processor";

const pgConfig = (config: ConfigService) => ({
  host: config.get<string>("DB_HOST", "localhost"),
  port: config.get<number>("DB_PORT", 5432),
  database: config.get<string>("DB_NAME", "camino_seguro_db"),
  user: config.get<string>("DB_USER", "app_user"),
  password: config.get<string>("DB_PASSWORD"),
});

const usePostgres = (config: ConfigService) =>
  config.get<string>("OFFLINE_USE_POSTGRES") === "true";

/**
 * Sincronización offline idempotente para dispositivos de monitoras (Issue #16).
 * Depende de abordaje (#8), descenso (#9) y, a través de ellos, de la FSM de custodia (#7).
 */
@Module({
  imports: [AttendanceModule],
  controllers: [OfflineController],
  providers: [
    { provide: OFFLINE_SYNC_CLOCK, useValue: () => Date.now() },
    {
      provide: SYNC_OPERATION_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        usePostgres(config)
          ? PostgresSyncOperationRepository.fromConfig(pgConfig(config))
          : new InMemorySyncOperationRepository(),
    },
    {
      provide: DEVICE_REGISTRY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        usePostgres(config)
          ? PostgresDeviceRegistry.fromConfig(pgConfig(config))
          : new InMemoryDeviceRegistry(),
    },
    BoardingOfflineHandler,
    DisembarkOfflineHandler,
    {
      provide: OFFLINE_OPERATION_HANDLERS,
      inject: [BoardingOfflineHandler, DisembarkOfflineHandler],
      useFactory: (
        boarding: BoardingOfflineHandler,
        disembark: DisembarkOfflineHandler,
      ) => [boarding, disembark],
    },
    OfflineSyncProcessor,
  ],
  exports: [OfflineSyncProcessor],
})
export class OfflineModule {}
