/**
 * Tipos del despachador de notificaciones en tiempo real (Issue #15 — RF-12, RF-20, RNF-05).
 */

/** Códigos de `tipo_notificacion` sembrados en V007 que usa el despachador. */
export type NotificationTypeCode =
  | "ABORDAJE_EXITOSO"
  | "DESCENSO_EXITOSO"
  | "PROXIMIDAD_PARADA"
  | "INCIDENTE_ENTREGA";

/** Estados de `notificacion.estado_envio` (CHECK de V007). */
export type NotificationDeliveryState =
  "PENDIENTE" | "ENVIADA" | "ENTREGADA" | "LEIDA" | "FALLIDA" | "REINTENTO";

/** Orden de despacho hacia un acudiente legitimado (fila de `notificacion`). */
export interface DispatchNotificationCommand {
  /** Identificador sugerido (p. ej. el ya creado por las funciones atómicas V015/V016). */
  readonly id_notificacion?: string | null;
  /** Clave idempotente (`notificacion.idempotency_key`, UNIQUE). */
  readonly idempotency_key: string;
  readonly codigo_tipo: NotificationTypeCode;
  readonly id_acudiente: string;
  readonly id_estudiante: string | null;
  readonly id_viaje: string | null;
  readonly titulo: string;
  readonly mensaje: string;
  readonly payload: Readonly<Record<string, string>>;
  readonly silenciable?: boolean;
  /** Instante del evento de negocio, base de la medición de latencia (< 2,5 s). */
  readonly ocurrido_en: Date;
}

/** Fila persistida en `notificacion`. */
export interface StoredNotification {
  readonly id_notificacion: string;
  readonly idempotency_key: string;
  readonly codigo_tipo: NotificationTypeCode;
  readonly id_acudiente: string;
  readonly id_estudiante: string | null;
  readonly id_viaje: string | null;
  readonly canal: string;
  readonly titulo: string;
  readonly contenido_mensaje: string;
  readonly payload_adicional: Readonly<Record<string, string>>;
  readonly silenciable: boolean;
  readonly estado_envio: NotificationDeliveryState;
  readonly intentos_realizados: number;
  readonly max_intentos: number;
  readonly ultimo_error: string | null;
  readonly despachada_en: Date | null;
  readonly entregada_en: Date | null;
  readonly creado_en: Date;
}

export interface UpsertNotificationResult {
  readonly notification: StoredNotification;
  /** `false` si la fila ya existía por `idempotency_key` (p. ej. creada por V015/V016). */
  readonly created: boolean;
}

export interface RecordDeliveryAttemptInput {
  readonly estado_envio: Exclude<
    NotificationDeliveryState,
    "PENDIENTE" | "LEIDA"
  >;
  readonly ultimo_error: string | null;
}

/** Mensaje que reciben los canales de emisión. */
export interface OutboundNotification {
  readonly id_notificacion: string;
  readonly codigo_tipo: NotificationTypeCode;
  readonly id_acudiente: string;
  readonly id_estudiante: string | null;
  readonly id_viaje: string | null;
  readonly titulo: string;
  readonly mensaje: string;
  readonly payload: Readonly<Record<string, string>>;
  readonly silenciable: boolean;
  readonly intento: number;
  readonly fecha_hora: string;
}

export type ChannelDeliveryStatus =
  /** Al menos un cliente confirmó la recepción (ack). */
  | "DELIVERED"
  /** Emitido a clientes conectados sin confirmación dentro del plazo. */
  | "SENT_UNCONFIRMED"
  /** El acudiente no tiene sesión activa en el canal. */
  | "NO_RECIPIENT"
  | "ERROR";

export interface ChannelDeliveryResult {
  readonly channel: string;
  readonly status: ChannelDeliveryStatus;
  readonly detail?: string;
}

export type DispatchOutcomeStatus =
  | "ENTREGADA"
  | "FALLIDA"
  | "YA_ENTREGADA"
  | "SIN_CANALES"
  | "ERROR_PERSISTENCIA";

export interface DispatchOutcome {
  readonly status: DispatchOutcomeStatus;
  readonly id_notificacion: string | null;
  readonly idempotency_key: string;
  readonly intentos: number;
  /** Latencia desde `ocurrido_en` hasta la primera emisión confirmada. */
  readonly latencia_ms: number | null;
}
