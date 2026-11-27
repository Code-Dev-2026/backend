import { Injectable } from "@nestjs/common";
import { uuidv7 } from "@common/utils/uuidv7";
import { INotificationRepository } from "../domain/notification-dispatch.ports";
import {
  DispatchNotificationCommand,
  NotificationTypeCode,
  RecordDeliveryAttemptInput,
  StoredNotification,
  UpsertNotificationResult,
} from "../domain/notification-dispatch.types";

/** Espejo del catálogo semilla `tipo_notificacion` (V007): canal por defecto de cada código. */
const DEFAULT_CHANNEL_BY_TYPE: Record<NotificationTypeCode, string> = {
  ABORDAJE_EXITOSO: "PUSH",
  DESCENSO_EXITOSO: "PUSH",
  PROXIMIDAD_PARADA: "PUSH",
  INCIDENTE_ENTREGA: "SMS",
};

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Adaptador en memoria de `notificacion` (modo por defecto, `NOTIFICATIONS_USE_POSTGRES != true`).
 * Replica la unicidad de `idempotency_key` y el contador `intentos_realizados`.
 */
@Injectable()
export class InMemoryNotificationRepository implements INotificationRepository {
  private readonly byId = new Map<string, StoredNotification>();
  private readonly idByKey = new Map<string, string>();

  async upsertPending(
    command: DispatchNotificationCommand,
  ): Promise<UpsertNotificationResult> {
    const existingId = this.idByKey.get(command.idempotency_key);
    if (existingId) {
      return {
        notification: { ...this.byId.get(existingId)! },
        created: false,
      };
    }

    const requestedId = command.id_notificacion?.trim();
    const id =
      requestedId && !this.byId.has(requestedId) ? requestedId : uuidv7();
    const stored: StoredNotification = {
      id_notificacion: id,
      idempotency_key: command.idempotency_key,
      codigo_tipo: command.codigo_tipo,
      id_acudiente: command.id_acudiente,
      id_estudiante: command.id_estudiante,
      id_viaje: command.id_viaje,
      canal: DEFAULT_CHANNEL_BY_TYPE[command.codigo_tipo],
      titulo: command.titulo,
      contenido_mensaje: command.mensaje,
      payload_adicional: { ...command.payload },
      silenciable: command.silenciable ?? false,
      estado_envio: "PENDIENTE",
      intentos_realizados: 0,
      max_intentos: DEFAULT_MAX_ATTEMPTS,
      ultimo_error: null,
      despachada_en: null,
      entregada_en: null,
      creado_en: new Date(),
    };
    this.byId.set(id, stored);
    this.idByKey.set(command.idempotency_key, id);
    return { notification: { ...stored }, created: true };
  }

  async recordAttempt(
    idNotificacion: string,
    input: RecordDeliveryAttemptInput,
  ): Promise<StoredNotification> {
    const current = this.byId.get(idNotificacion);
    if (!current) {
      throw new Error(`Notificación ${idNotificacion} inexistente.`);
    }
    const now = new Date();
    const sent =
      input.estado_envio === "ENVIADA" || input.estado_envio === "ENTREGADA";
    const updated: StoredNotification = {
      ...current,
      estado_envio: input.estado_envio,
      intentos_realizados: current.intentos_realizados + 1,
      ultimo_error: input.ultimo_error,
      despachada_en: sent
        ? (current.despachada_en ?? now)
        : current.despachada_en,
      entregada_en:
        input.estado_envio === "ENTREGADA"
          ? (current.entregada_en ?? now)
          : current.entregada_en,
    };
    this.byId.set(idNotificacion, updated);
    return { ...updated };
  }

  async findById(idNotificacion: string): Promise<StoredNotification | null> {
    const found = this.byId.get(idNotificacion);
    return found ? { ...found } : null;
  }

  findByIdempotencyKey(key: string): StoredNotification | null {
    const id = this.idByKey.get(key);
    return id ? { ...this.byId.get(id)! } : null;
  }

  listAll(): StoredNotification[] {
    return Array.from(this.byId.values()).map((n) => ({ ...n }));
  }
}
