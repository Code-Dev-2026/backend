import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  TELEMETRY_EVENT_DISPATCHER,
  TELEMETRY_INGEST_PORT,
} from "./domain/telemetry-ingest.port";
import { TELEMETRY_REPOSITORY } from "./domain/telemetry-repository.port";
import { InMemoryEventDispatcher } from "./infrastructure/in-memory-event-dispatcher";
import { InMemoryTelemetryRepository } from "./infrastructure/in-memory-telemetry.repository";
import { MqttTelemetrySubscriber } from "./infrastructure/mqtt-telemetry.subscriber";
import { PostgresTelemetryRepository } from "./infrastructure/postgres-telemetry.repository";
import { TelemetryIngestChannel } from "./infrastructure/telemetry-ingest.channel";
import {
  TELEMETRY_CLOCK,
  TelemetryPacketValidator,
} from "./telemetry-packet.validator";
import { TelemetryPartitionMaintenanceJob } from "./telemetry-partition-maintenance.job";
import { TelemetryController } from "./telemetry.controller";
import { TelemetryService } from "./telemetry.service";

@Module({
  controllers: [TelemetryController],
  providers: [
    {
      provide: TELEMETRY_CLOCK,
      useValue: () => new Date(),
    },
    TelemetryPacketValidator,
    TelemetryIngestChannel,
    {
      provide: TELEMETRY_INGEST_PORT,
      useExisting: TelemetryIngestChannel,
    },
    InMemoryEventDispatcher,
    {
      provide: TELEMETRY_EVENT_DISPATCHER,
      useExisting: InMemoryEventDispatcher,
    },
    {
      provide: TELEMETRY_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const usePostgres =
          config.get<string>("TELEMETRY_USE_POSTGRES") === "true";
        if (usePostgres) {
          return PostgresTelemetryRepository.fromConfig({
            host: config.get<string>("DB_HOST", "localhost"),
            port: config.get<number>("DB_PORT", 5432),
            database: config.get<string>("DB_NAME", "camino_seguro_db"),
            user: config.get<string>("DB_USER", "app_user"),
            password: config.get<string>("DB_PASSWORD"),
          });
        }
        return new InMemoryTelemetryRepository();
      },
    },
    TelemetryService,
    MqttTelemetrySubscriber,
    TelemetryPartitionMaintenanceJob,
  ],
  exports: [
    TelemetryService,
    TelemetryPacketValidator,
    TelemetryPartitionMaintenanceJob,
    MqttTelemetrySubscriber,
    TELEMETRY_INGEST_PORT,
    TELEMETRY_EVENT_DISPATCHER,
    TELEMETRY_REPOSITORY,
  ],
})
export class TelemetryModule {}
