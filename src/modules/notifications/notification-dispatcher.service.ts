import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import {
  DEFAULT_NOTIFICATION_DISPATCH_OPTIONS,
  INotificationRepository,
  NOTIFICATION_DISPATCH_OPTIONS,
  NOTIFICATION_LATENCY_BUDGET_MS,
  NOTIFICATION_REPOSITORY,
  NotificationDispatchOptions,
} from "./domain/notification-dispatch.ports";
import {
  ChannelDeliveryResult,
  DispatchNotificationCommand,
  DispatchOutcome,
  OutboundNotification,
  StoredNotification,
} from "./domain/notification-dispatch.types";
import { NotificationChannelRegistry } from "./notification-channel.registry";

export interface NotificationDispatcherMetrics {
  readonly enqueued: number;
  readonly delivered: number;
  readonly failed: number;
  readonly duplicatesSkipped: number;
  readonly retries: number;
  readonly persistenceErrors: number;
  readonly overBudget: number;
  readonly maxLatencyMs: number;
  readonly queued: number;
  readonly inFlight: number;
}

interface QueueItem {
  readonly command: DispatchNotificationCommand;
  readonly resolve: (outcome: DispatchOutcome) => void;
}

const TERMINAL_DELIVERED = new Set(["ENTREGADA", "LEIDA"]);

/**
 * Despachador de notificaciones y eventos en tiempo real (Issue #15 — RF-12, RF-20, RNF-05).
 *
 * 1. Cola en memoria asíncrona y no bloqueante: `enqueue` retorna de inmediato y la
 *    cola procesa con concurrencia acotada (mitigación de horas pico de abordaje).
 * 2. Persiste la fila en `notificacion` clasificada por `tipo_notificacion`, idempotente
 *    por `idempotency_key` (reutiliza las filas que ya crean las funciones V015/V016).
 * 3. Entrega a todos los `INotificationChannelPort` registrados; la confirmación (ack)
 *    del cliente marca `ENTREGADA`. Sin confirmación reintenta con backoff hasta
 *    `max_intentos` y deja `FALLIDA` con `ultimo_error`.
 */
@Injectable()
export class NotificationDispatcherService {
  private readonly logger = new Logger(NotificationDispatcherService.name);
  private readonly options: NotificationDispatchOptions;
  private readonly queue: QueueItem[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private readonly idleWaiters: Array<() => void> = [];

  private metrics = {
    enqueued: 0,
    delivered: 0,
    failed: 0,
    duplicatesSkipped: 0,
    retries: 0,
    persistenceErrors: 0,
    overBudget: 0,
    maxLatencyMs: 0,
  };

  constructor(
    @Inject(NOTIFICATION_REPOSITORY)
    private readonly repository: INotificationRepository,
    private readonly channels: NotificationChannelRegistry,
    @Optional()
    @Inject(NOTIFICATION_DISPATCH_OPTIONS)
    options?: Partial<NotificationDispatchOptions>,
  ) {
    this.options = { ...DEFAULT_NOTIFICATION_DISPATCH_OPTIONS, ...options };
  }

  /** Encola sin bloquear al caso de uso; la promesa resuelve al terminar el despacho. */
  enqueue(command: DispatchNotificationCommand): Promise<DispatchOutcome> {
    this.metrics.enqueued += 1;
    return new Promise<DispatchOutcome>((resolve) => {
      this.queue.push({ command, resolve });
      this.pump();
    });
  }

  /** Espera a que la cola quede vacía (uso en pruebas y apagado ordenado). */
  async drain(): Promise<void> {
    if (this.queue.length === 0 && this.inFlight.size === 0) {
      return;
    }
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  getMetrics(): NotificationDispatcherMetrics {
    return {
      ...this.metrics,
      queued: this.queue.length,
      inFlight: this.inFlight.size,
    };
  }

  private pump(): void {
    while (
      this.queue.length > 0 &&
      this.inFlight.size < this.options.maxConcurrency
    ) {
      const item = this.queue.shift()!;
      const task = this.process(item.command)
        .catch((err: unknown): DispatchOutcome => {
          this.logger.error(
            `Fallo inesperado despachando ${item.command.idempotency_key}: ${errorMessage(err)}`,
          );
          return {
            status: "ERROR_PERSISTENCIA",
            id_notificacion: null,
            idempotency_key: item.command.idempotency_key,
            intentos: 0,
            latencia_ms: null,
          };
        })
        .then((outcome) => item.resolve(outcome));

      const tracked: Promise<void> = task.finally(() => {
        this.inFlight.delete(tracked);
        this.pump();
        if (this.queue.length === 0 && this.inFlight.size === 0) {
          this.idleWaiters.splice(0).forEach((resolve) => resolve());
        }
      });
      this.inFlight.add(tracked);
    }
  }

  private async process(
    command: DispatchNotificationCommand,
  ): Promise<DispatchOutcome> {
    let stored: StoredNotification;
    try {
      stored = (await this.repository.upsertPending(command)).notification;
    } catch (err: unknown) {
      this.metrics.persistenceErrors += 1;
      this.logger.error(
        `No se pudo persistir la notificación ${command.idempotency_key}: ${errorMessage(err)}`,
      );
      return outcome("ERROR_PERSISTENCIA", null, command, 0, null);
    }

    if (TERMINAL_DELIVERED.has(stored.estado_envio)) {
      this.metrics.duplicatesSkipped += 1;
      return outcome(
        "YA_ENTREGADA",
        stored.id_notificacion,
        command,
        stored.intentos_realizados,
        null,
      );
    }

    const channels = this.channels.list();
    if (channels.length === 0) {
      this.logger.warn(
        `Sin canales de emisión registrados: ${stored.id_notificacion} queda PENDIENTE.`,
      );
      return outcome("SIN_CANALES", stored.id_notificacion, command, 0, null);
    }

    const remaining = Math.max(
      1,
      stored.max_intentos - stored.intentos_realizados,
    );
    for (let attempt = 1; attempt <= remaining; attempt++) {
      const intento = stored.intentos_realizados + 1;
      const results = await Promise.all(
        channels.map((channel) =>
          channel
            .deliver(toOutbound(stored, intento))
            .catch((err: unknown): ChannelDeliveryResult => ({
              channel: channel.name,
              status: "ERROR",
              detail: errorMessage(err),
            })),
        ),
      );

      if (results.some((r) => r.status === "DELIVERED")) {
        const latency = Date.now() - command.ocurrido_en.getTime();
        stored = await this.repository.recordAttempt(stored.id_notificacion, {
          estado_envio: "ENTREGADA",
          ultimo_error: null,
        });
        this.recordLatency(latency, stored.id_notificacion);
        this.metrics.delivered += 1;
        return outcome(
          "ENTREGADA",
          stored.id_notificacion,
          command,
          stored.intentos_realizados,
          latency,
        );
      }

      const isLast = attempt === remaining;
      const anySent = results.some((r) => r.status === "SENT_UNCONFIRMED");
      stored = await this.repository.recordAttempt(stored.id_notificacion, {
        estado_envio: isLast ? "FALLIDA" : anySent ? "ENVIADA" : "REINTENTO",
        ultimo_error: describeFailure(results),
      });

      if (isLast) {
        this.metrics.failed += 1;
        return outcome(
          "FALLIDA",
          stored.id_notificacion,
          command,
          stored.intentos_realizados,
          null,
        );
      }

      this.metrics.retries += 1;
      await sleep(this.backoffFor(attempt));
    }

    // Inalcanzable: el bucle siempre retorna en su último intento.
    return outcome("FALLIDA", stored.id_notificacion, command, 0, null);
  }

  private backoffFor(attempt: number): number {
    const table = this.options.retryBackoffMs;
    return table[Math.min(attempt - 1, table.length - 1)] ?? 0;
  }

  private recordLatency(latencyMs: number, idNotificacion: string): void {
    this.metrics.maxLatencyMs = Math.max(this.metrics.maxLatencyMs, latencyMs);
    if (latencyMs >= NOTIFICATION_LATENCY_BUDGET_MS) {
      this.metrics.overBudget += 1;
      this.logger.warn(
        `Notificación ${idNotificacion} entregada en ${latencyMs} ms (RNF-05: < ${NOTIFICATION_LATENCY_BUDGET_MS} ms).`,
      );
    }
  }
}

function toOutbound(
  stored: StoredNotification,
  intento: number,
): OutboundNotification {
  return {
    id_notificacion: stored.id_notificacion,
    codigo_tipo: stored.codigo_tipo,
    id_acudiente: stored.id_acudiente,
    id_estudiante: stored.id_estudiante,
    id_viaje: stored.id_viaje,
    titulo: stored.titulo,
    mensaje: stored.contenido_mensaje,
    payload: stored.payload_adicional,
    silenciable: stored.silenciable,
    intento,
    fecha_hora: stored.creado_en.toISOString(),
  };
}

function outcome(
  status: DispatchOutcome["status"],
  idNotificacion: string | null,
  command: DispatchNotificationCommand,
  intentos: number,
  latencia: number | null,
): DispatchOutcome {
  return {
    status,
    id_notificacion: idNotificacion,
    idempotency_key: command.idempotency_key,
    intentos,
    latencia_ms: latencia,
  };
}

function describeFailure(results: readonly ChannelDeliveryResult[]): string {
  return results
    .map((r) => `${r.channel}:${r.status}${r.detail ? `(${r.detail})` : ""}`)
    .join("; ")
    .slice(0, 500);
}

/** Espera de backoff que no retiene el proceso al apagar la aplicación. */
function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
