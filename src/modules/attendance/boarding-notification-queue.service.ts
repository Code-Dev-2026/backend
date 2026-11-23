import { Injectable, Logger, Optional } from "@nestjs/common";
import { uuidv7 } from "@common/utils/uuidv7";
import { NotificationsService } from "../notifications/notifications.service";

export interface EnqueueBoardingPushInput {
  id_notificacion_existente?: string | null;
  id_viaje: string;
  id_estudiante: string;
  id_acudiente_titular: string | null;
  id_asistencia: string;
  total_a_bordo: number;
  capacidad_nominal: number;
  fecha_hora: Date;
}

export interface QueuedBoardingNotification {
  id_notificacion: string;
  idempotency_key: string;
  id_viaje: string;
  id_estudiante: string;
  id_acudiente: string;
  estado: "ENCOLADA" | "DESPACHADA" | "FALLIDA";
  encolada_en: string;
}

/**
 * Cola ligera y no bloqueante para el encolamiento de notificaciones push
 * hacia el acudiente titular al confirmarse un abordaje (Issue #8).
 *
 * Mantiene el tiempo de respuesta del escaneo QR < 200 ms despachando el envío
 * fuera del camino crítico de la transacción de abordaje.
 */
@Injectable()
export class BoardingNotificationQueueService {
  private readonly logger = new Logger(BoardingNotificationQueueService.name);
  private readonly queuedByKey = new Map<string, QueuedBoardingNotification>();
  private readonly pendingDispatches = new Set<Promise<void>>();

  constructor(
    @Optional()
    private readonly notificationsService?: NotificationsService,
  ) {}

  enqueueGuardianBoardingNotification(
    input: EnqueueBoardingPushInput,
  ): { encolada: boolean; id_notificacion: string | null } {
    if (!input.id_acudiente_titular) {
      return { encolada: false, id_notificacion: null };
    }

    const idempotencyKey = `abordaje:${input.id_viaje}:${input.id_estudiante}`;
    const existing = this.queuedByKey.get(idempotencyKey);
    if (existing) {
      return { encolada: true, id_notificacion: existing.id_notificacion };
    }

    const idNotificacion = input.id_notificacion_existente ?? uuidv7();
    const record: QueuedBoardingNotification = {
      id_notificacion: idNotificacion,
      idempotency_key: idempotencyKey,
      id_viaje: input.id_viaje,
      id_estudiante: input.id_estudiante,
      id_acudiente: input.id_acudiente_titular,
      estado: "ENCOLADA",
      encolada_en: new Date().toISOString(),
    };
    this.queuedByKey.set(idempotencyKey, record);

    if (this.notificationsService) {
      const dispatchPromise = Promise.resolve()
        .then(async () => {
          await this.notificationsService!.sendPushNotification({
            id_estudiante: input.id_estudiante,
            id_acudiente: input.id_acudiente_titular!,
            titulo: "Abordaje confirmado",
            mensaje: "El estudiante ha subido al vehículo escolar.",
            tipo_alerta: "TRANSICION_CUSTODIA",
            datos_adicionales: {
              id_viaje: input.id_viaje,
              id_asistencia: input.id_asistencia,
              id_notificacion: idNotificacion,
              total_a_bordo: String(input.total_a_bordo),
              capacidad_nominal: String(input.capacidad_nominal),
              fecha_hora: input.fecha_hora.toISOString(),
            },
          });
          record.estado = "DESPACHADA";
        })
        .catch((error: unknown) => {
          record.estado = "FALLIDA";
          this.logger.warn(
            `Error despachando push encolado ${idNotificacion}: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => {
          this.pendingDispatches.delete(dispatchPromise);
        });

      this.pendingDispatches.add(dispatchPromise);
    }

    return { encolada: true, id_notificacion: idNotificacion };
  }

  listQueuedNotifications(): QueuedBoardingNotification[] {
    return Array.from(this.queuedByKey.values()).map((item) => ({ ...item }));
  }

  async flushPendingDispatches(): Promise<void> {
    await Promise.allSettled(Array.from(this.pendingDispatches));
  }
}
