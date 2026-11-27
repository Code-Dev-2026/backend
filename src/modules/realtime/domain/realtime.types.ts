/** Tipo de principal autenticado en el handshake WebSocket. */
export type StreamingPrincipalKind = "STAFF" | "GUARDIAN";

export interface StreamingPrincipal {
  readonly id_usuario: string;
  readonly email: string;
  readonly roles: readonly string[];
  readonly kind: StreamingPrincipalKind;
  /** Expiración del Access Token (epoch ms); el socket se cierra al vencer. */
  readonly expiresAtMs: number;
}

/** Vínculo familiar `acudiente` ↔ `estudiante_acudiente` resuelto al `id_usuario` del JWT. */
export interface GuardianStudentLink {
  readonly id_usuario: string;
  readonly id_acudiente: string;
  readonly id_estudiante: string;
}

/** Estado de custodia de un estudiante inscrito en el viaje (`viaje_estudiante`). */
export interface TripStudentCustody {
  readonly id_estudiante: string;
  readonly estado_custodia: string;
}

/** Hijos del acudiente inscritos en el viaje, con su estado de custodia actual. */
export type TripGuardianAudience = ReadonlyMap<
  string,
  readonly TripStudentCustody[]
>;

export type StreamDecisionReason =
  | "PERSONAL_AUTORIZADO"
  | "ESTUDIANTE_A_BORDO"
  | "SIN_ESTUDIANTE_A_BORDO"
  | "SIN_VINCULO_CON_VIAJE";

export interface StreamDecision {
  readonly allowed: boolean;
  readonly reason: StreamDecisionReason;
  /** Solo los hijos del propio acudiente (RNF-02); vacío para personal. */
  readonly estudiantes: readonly TripStudentCustody[];
}

/** Frame GPS mínimo difundido a los clientes (sin metadatos internos de ingesta). */
export interface GpsStreamFrame {
  readonly id_viaje: string;
  readonly id_vehiculo: string;
  readonly placa: string;
  readonly latitud: number;
  readonly longitud: number;
  readonly velocidad_kmh: number;
  readonly rumbo_grados: number | null;
  readonly fecha_hora: string;
}

export type SubscriptionReason =
  StreamDecisionReason | "ID_VIAJE_INVALIDO" | "LIMITE_SUSCRIPCIONES";

/** Evento `trip:stream_status`: se emite al (re)suscribir y cada vez que cambia `transmitiendo`. */
export interface StreamStatusPayload {
  readonly id_viaje: string | null;
  readonly suscrito: boolean;
  readonly transmitiendo: boolean;
  readonly motivo: SubscriptionReason;
  readonly estudiantes: readonly TripStudentCustody[];
  readonly fecha_hora: string;
}

export interface SubscribeAck {
  readonly subscribed: boolean;
  readonly room: string | null;
  readonly transmitiendo: boolean;
  readonly motivo: SubscriptionReason;
  readonly estudiantes: readonly TripStudentCustody[];
}
