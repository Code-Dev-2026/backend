import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CUSTODY_FSM_PORT } from "@common/ports/custody-fsm.port";
import { AuditModule } from "../audit/audit.module";
import { CustodyController } from "./custody.controller";
import { CustodyService } from "./custody.service";
import { CustodyTransitionValidatorService } from "./custody-transition-validator.service";
import { CUSTODY_REPOSITORY } from "./domain/custody-repository.port";
import { InMemoryCustodyRepository } from "./infrastructure/in-memory-custody.repository";
import { PostgresCustodyRepository } from "./infrastructure/postgres-custody.repository";
import { JUDICIAL_ALERT_REPOSITORY } from "./judicial-alerts/domain/judicial-alert-repository.port";
import { InMemoryJudicialAlertRepository } from "./judicial-alerts/infrastructure/in-memory-judicial-alert.repository";
import { PostgresJudicialAlertRepository } from "./judicial-alerts/infrastructure/postgres-judicial-alert.repository";
import { JudicialAlertsController } from "./judicial-alerts/judicial-alerts.controller";
import { JudicialAlertsService } from "./judicial-alerts/judicial-alerts.service";
import { MorningCustodyInitJob } from "./morning-custody-init.job";

@Module({
  imports: [AuditModule],
  controllers: [CustodyController, JudicialAlertsController],
  providers: [
    {
      provide: CUSTODY_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const usePostgres =
          config.get<string>("CUSTODY_USE_POSTGRES") === "true";
        if (usePostgres) {
          return PostgresCustodyRepository.fromConfig({
            host: config.get<string>("DB_HOST", "localhost"),
            port: config.get<number>("DB_PORT", 5432),
            database: config.get<string>("DB_NAME", "camino_seguro_db"),
            user: config.get<string>("DB_USER", "app_user"),
            password: config.get<string>("DB_PASSWORD", "camino_seguro_pass"),
          });
        }
        return new InMemoryCustodyRepository();
      },
    },
    {
      provide: JUDICIAL_ALERT_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const usePostgres =
          config.get<string>("CUSTODY_USE_POSTGRES") === "true" ||
          config.get<string>("ATTENDANCE_USE_POSTGRES") === "true";
        if (usePostgres) {
          return PostgresJudicialAlertRepository.fromConfig({
            host: config.get<string>("DB_HOST", "localhost"),
            port: config.get<number>("DB_PORT", 5432),
            database: config.get<string>("DB_NAME", "camino_seguro_db"),
            user: config.get<string>("DB_USER", "app_user"),
            password: config.get<string>("DB_PASSWORD", "camino_seguro_pass"),
          });
        }
        return new InMemoryJudicialAlertRepository();
      },
    },
    CustodyTransitionValidatorService,
    MorningCustodyInitJob,
    CustodyService,
    JudicialAlertsService,
    { provide: CUSTODY_FSM_PORT, useExisting: CustodyService },
  ],
  exports: [
    CustodyService,
    CustodyTransitionValidatorService,
    MorningCustodyInitJob,
    JudicialAlertsService,
    CUSTODY_FSM_PORT,
    CUSTODY_REPOSITORY,
    JUDICIAL_ALERT_REPOSITORY,
  ],
})
export class CustodyModule {}
