import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CUSTODY_FSM_PORT } from "@common/ports/custody-fsm.port";
import { CustodyController } from "./custody.controller";
import { CustodyService } from "./custody.service";
import { CustodyTransitionValidatorService } from "./custody-transition-validator.service";
import { CUSTODY_REPOSITORY } from "./domain/custody-repository.port";
import { InMemoryCustodyRepository } from "./infrastructure/in-memory-custody.repository";
import { PostgresCustodyRepository } from "./infrastructure/postgres-custody.repository";
import { MorningCustodyInitJob } from "./morning-custody-init.job";

@Module({
  controllers: [CustodyController],
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
    CustodyTransitionValidatorService,
    MorningCustodyInitJob,
    CustodyService,
    { provide: CUSTODY_FSM_PORT, useExisting: CustodyService },
  ],
  exports: [
    CustodyService,
    CustodyTransitionValidatorService,
    MorningCustodyInitJob,
    CUSTODY_FSM_PORT,
    CUSTODY_REPOSITORY,
  ],
})
export class CustodyModule {}
