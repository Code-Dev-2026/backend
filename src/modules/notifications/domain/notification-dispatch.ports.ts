import {
  ChannelDeliveryResult,
  DispatchNotificationCommand,
  OutboundNotification,
  RecordDeliveryAttemptInput,
  StoredNotification,
  UpsertNotificationResult,
} from "./notification-dispatch.types";

export const NOTIFICATION_REPOSITORY = Symbol("NOTIFICATION_REPOSITORY");
export const NOTIFICATION_RECIPIENT_DIRECTORY = Symbol(
  "NOTIFICATION_RECIPIENT_DIRECTORY",
);
export const NOTIFICATION_DISPATCH_OPTIONS = Symbol(
  "NOTIFICATION_DISPATCH_OPTIONS",
);

/**
 * Canal de emisión desacoplado (OCP — Issue #15). El despachador entrega cada
 * notificación a todos los canales registrados sin conocer su transporte.
 */
export interface INotificationChannelPort {
  readonly name: string;
  deliver(notification: OutboundNotification): Promise<ChannelDeliveryResult>;
}

/** Persistencia transaccional en `notificacion` clasificada por `tipo_notificacion` (DIP). */
export interface INotificationRepository {
  /** Inserta en estado PENDIENTE o devuelve la fila existente con la misma `idempotency_key`. */
  upsertPending(
    command: DispatchNotificationCommand,
  ): Promise<UpsertNotificationResult>;

  /** Registra un intento de entrega (incrementa `intentos_realizados`). */
  recordAttempt(
    idNotificacion: string,
    input: RecordDeliveryAttemptInput,
  ): Promise<StoredNotification>;

  findById(idNotificacion: string): Promise<StoredNotification | null>;
}

/** Acudientes legitimados de un estudiante (`estudiante_acudiente`, cuenta ACTIVO). */
export interface INotificationRecipientDirectory {
  listGuardianIdsOfStudent(idEstudiante: string): Promise<string[]>;
}

export interface NotificationDispatchOptions {
  /** Plazo de confirmación (ack) del cliente WebSocket. */
  readonly ackTimeoutMs: number;
  /** Espera antes de cada reintento (longitud = intentos - 1). */
  readonly retryBackoffMs: readonly number[];
  /** Despachos simultáneos máximos de la cola en memoria. */
  readonly maxConcurrency: number;
}

export const DEFAULT_NOTIFICATION_DISPATCH_OPTIONS: NotificationDispatchOptions =
  {
    ackTimeoutMs: 1500,
    retryBackoffMs: [1000, 3000],
    maxConcurrency: 20,
  };

/** RNF-05: latencia de notificación inferior a 2,5 s. */
export const NOTIFICATION_LATENCY_BUDGET_MS = 2500;
