import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ITelemetryRepository,
  TELEMETRY_REPOSITORY,
} from "./domain/telemetry-repository.port";
import { PartitionMaintenanceSummary } from "./domain/telemetry.types";

/**
 * Job de mantenimiento periódico de particiones mensuales de `registro_gps`
 * y retención de 180 días (Issue #12).
 *
 * Invoca `fn_crear_particion_gps_mensual` (vía `ensureMonthlyPartitions`) y
 * purga particiones vencidas mayores a 180 días (vía `purgeExpiredPartitions`).
 * Desactivado por defecto en desarrollo/pruebas (`TELEMETRY_PARTITION_JOB_ENABLED=false`).
 */
@Injectable()
export class TelemetryPartitionMaintenanceJob
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(TelemetryPartitionMaintenanceJob.name);
  private timer: NodeJS.Timeout | null = null;
  private lastSummary: PartitionMaintenanceSummary | null = null;

  constructor(
    @Inject(TELEMETRY_REPOSITORY)
    private readonly telemetryRepository: ITelemetryRepository,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  onModuleInit(): void {
    const enabled =
      this.configService?.get<string>("TELEMETRY_PARTITION_JOB_ENABLED") ===
      "true";
    if (!enabled) {
      return;
    }

    const intervalMs = Number(
      this.configService?.get<number>("TELEMETRY_PARTITION_JOB_INTERVAL_MS") ??
        3_600_000,
    );

    void this.runMaintenance(new Date()).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Error en ejecución inicial de mantenimiento de particiones GPS: ${msg}`,
      );
    });

    this.timer = setInterval(() => {
      void this.runMaintenance(new Date()).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Error en mantenimiento periódico de particiones GPS: ${msg}`,
        );
      });
    }, intervalMs);

    this.timer.unref?.();
    this.logger.log(
      `Job de mantenimiento de particiones GPS activado (cada ${intervalMs} ms).`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runMaintenance(
    referenceDate: Date = new Date(),
  ): Promise<PartitionMaintenanceSummary> {
    const monthsAhead = Number(
      this.configService?.get<number>("TELEMETRY_PARTITION_MONTHS_AHEAD") ?? 2,
    );
    const retentionDays = Number(
      this.configService?.get<number>("TELEMETRY_RETENTION_DAYS") ?? 180,
    );

    const createdOrVerified =
      await this.telemetryRepository.ensureMonthlyPartitions(
        referenceDate,
        monthsAhead,
      );
    const purged = await this.telemetryRepository.purgeExpiredPartitions(
      retentionDays,
      referenceDate,
    );

    const summary: PartitionMaintenanceSummary = {
      executed_at: referenceDate.toISOString(),
      created_or_verified: createdOrVerified,
      purged,
    };
    this.lastSummary = summary;

    const createdCount = createdOrVerified.filter((p) => p.creada).length;
    this.logger.log(
      `Mantenimiento GPS completado: ${createdCount} partición(es) nueva(s), ${createdOrVerified.length} verificada(s), ${purged.length} purgada(s) (> ${retentionDays} días).`,
    );

    return summary;
  }

  getLastSummary(): PartitionMaintenanceSummary | null {
    return this.lastSummary;
  }
}
