import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthModule } from "../auth/auth.module";
import { CustodyModule } from "../custody/custody.module";
import { CustodyService } from "../custody/custody.service";
import { TelemetryModule } from "../telemetry/telemetry.module";
import {
  GUARDIAN_LINK_REPOSITORY,
  REALTIME_CLOCK,
  TRIP_CUSTODY_READER,
} from "./domain/realtime-ports";
import { InMemoryGuardianLinkRepository } from "./infrastructure/in-memory-guardian-link.repository";
import { PostgresGuardianLinkRepository } from "./infrastructure/postgres-guardian-link.repository";
import { StreamingAuthorizationFilter } from "./streaming-authorization.filter";
import { TelemetryGateway } from "./telemetry.gateway";
import { TripSubscriptionManager } from "./trip-subscription.manager";
import { WsHandshakeAuthenticator } from "./ws-handshake.authenticator";

/**
 * Pasarela WebSocket de seguimiento en vivo con salas segmentadas y aislamiento familiar (Issue #14).
 * Depende de JWT (#3), custodia FSM (#7) y eventos telemáticos (#12).
 */
@Module({
  imports: [AuthModule, CustodyModule, TelemetryModule],
  providers: [
    { provide: REALTIME_CLOCK, useValue: () => Date.now() },
    {
      provide: GUARDIAN_LINK_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        if (config.get<string>("REALTIME_USE_POSTGRES") === "true") {
          return PostgresGuardianLinkRepository.fromConfig({
            host: config.get<string>("DB_HOST", "localhost"),
            port: config.get<number>("DB_PORT", 5432),
            database: config.get<string>("DB_NAME", "camino_seguro_db"),
            user: config.get<string>("DB_USER", "app_user"),
            password: config.get<string>("DB_PASSWORD"),
          });
        }
        return new InMemoryGuardianLinkRepository();
      },
    },
    { provide: TRIP_CUSTODY_READER, useExisting: CustodyService },
    StreamingAuthorizationFilter,
    TripSubscriptionManager,
    WsHandshakeAuthenticator,
    TelemetryGateway,
  ],
  exports: [TelemetryGateway, StreamingAuthorizationFilter],
})
export class RealtimeModule {}
