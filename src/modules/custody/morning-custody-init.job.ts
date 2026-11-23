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
  CUSTODY_REPOSITORY,
  ICustodyRepository,
} from "./domain/custody-repository.port";
import { MorningInitializationSummary } from "./domain/custody.types";

/**
 * Job de inicialización matutina de estados de custodia (`NO_INICIADO`) para los
 * estudiantes con servicio contratado en los viajes del día (Issue #7).
 *
 * Implementado sin dependencias externas mediante programación nativa configurable
 * (desactivada por defecto en pruebas/desarrollo) y ejecución idempotente por fecha.
 */
@Injectable()
export class MorningCustodyInitJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MorningCustodyInitJob.name);
  private timer: NodeJS.Timeout | null = null;
  private lastExecutedDate: string | null = null;

  constructor(
    @Inject(CUSTODY_REPOSITORY)
    private readonly custodyRepository: ICustodyRepository,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  onModuleInit(): void {
    const enabled =
      this.configService?.get<string>("CUSTODY_MORNING_JOB_ENABLED") === "true";

    if (!enabled) {
      return;
    }

    const intervalMs = Number(
      this.configService?.get<number>("CUSTODY_MORNING_JOB_INTERVAL_MS") ??
        60000,
    );

    this.timer = setInterval(() => {
      void this.tick(new Date()).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Error en job de inicialización matutina: ${msg}`);
      });
    }, intervalMs);

    this.timer.unref?.();
    this.logger.log(
      `Job de inicialización matutina de custodia activado (revisión cada ${intervalMs} ms).`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Evalúa si ya se alcanzó la hora configurada para el día en curso y ejecuta
   * la inicialización exactamente una vez por día (idempotente).
   */
  async tick(now: Date = new Date()): Promise<MorningInitializationSummary | null> {
    const targetHour = Number(
      this.configService?.get<number>("CUSTODY_MORNING_JOB_HOUR") ?? 5,
    );
    const targetMinute = Number(
      this.configService?.get<number>("CUSTODY_MORNING_JOB_MINUTE") ?? 0,
    );

    const today = this.formatDateIso(now);
    if (this.lastExecutedDate === today) {
      return null;
    }

    const reachedSchedule =
      now.getHours() > targetHour ||
      (now.getHours() === targetHour && now.getMinutes() >= targetMinute);

    if (!reachedSchedule) {
      return null;
    }

    const summary = await this.runForDate(today);
    this.lastExecutedDate = today;
    return summary;
  }

  /**
   * Ejecuta de forma idempotente la inicialización diaria en `viaje_estudiante`
   * en estado `NO_INICIADO` para la fecha indicada (`YYYY-MM-DD`).
   */
  async runForDate(fecha?: string): Promise<MorningInitializationSummary> {
    const targetDate = fecha ?? this.formatDateIso(new Date());
    const summary =
      await this.custodyRepository.initializeMorningCustody(targetDate);

    this.logger.log(
      `Inicialización matutina de custodia ejecutada para ${targetDate}: ${summary.registros_inicializados} registro(s) creados en NO_INICIADO.`,
    );

    return summary;
  }

  getLastExecutedDate(): string | null {
    return this.lastExecutedDate;
  }

  private formatDateIso(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
}
