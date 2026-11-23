import { FsmCustodyState } from "../../custody/domain/custody.types";

/**
 * Códigos estructurados no fatales de respuesta para el control atómico
 * de abordaje QR (Issue #8: RF-08, RN-02, RN-05).
 */
export enum BoardingResultCode {
  ABORDAJE_EXITOSO = "ABORDAJE_EXITOSO",
  DENEGADO_SOBRECUPO = "DENEGADO_SOBRECUPO",
  ABORDAJE_PREVIO_EXISTE = "ABORDAJE_PREVIO_EXISTE",
}

export type BoardingValidationMethod =
  | "QR_INSTITUCIONAL"
  | "QR_OCASIONAL_TEMPORAL"
  | "VERIFICACION_VISUAL_PARADA";

export type IncidentSeverity = "INFORMATIVO" | "ADVERTENCIA" | "CRITICO";

export interface AttendanceCoordinates {
  latitud: number;
  longitud: number;
}

export interface AtomicBoardingCommand {
  id_viaje: string;
  id_estudiante: string | null;
  qr_token_hash: string | null;
  metodo_validacion: BoardingValidationMethod;
  coordenadas: AttendanceCoordinates;
  registrado_por_usuario: string | null;
  idempotency_key: string | null;
  sincronizado_offline: boolean;
}

export interface AtomicBoardingRecord {
  aprobado: boolean;
  codigo: BoardingResultCode;
  mensaje: string;
  id_viaje: string;
  id_ruta: string;
  id_estudiante: string;
  id_asistencia: string | null;
  id_incidente: string | null;
  id_acudiente_titular: string | null;
  id_notificacion: string | null;
  estado_custodia: FsmCustodyState;
  metodo_validacion: BoardingValidationMethod;
  total_a_bordo: number;
  capacidad_nominal: number;
  duplicado_por_idempotencia: boolean;
  fecha_hora: Date;
}

export interface BoardingResponse {
  aprobado: boolean;
  codigo: BoardingResultCode;
  mensaje: string;
  id_viaje: string;
  id_ruta: string;
  id_estudiante: string;
  id_asistencia: string | null;
  id_incidente: string | null;
  estado_custodia: FsmCustodyState;
  metodo_validacion: BoardingValidationMethod;
  total_a_bordo: number;
  capacidad_nominal: number;
  cupos_disponibles: number;
  duplicado_por_idempotencia: boolean;
  evento_realtime_emitido: string | null;
  alerta_coordinacion_emitida: boolean;
  notificacion_acudiente_encolada: boolean;
  id_notificacion: string | null;
  latencia_ms: number;
  fecha_hora: string;
}

export interface CreateOperationalIncidentInput {
  id_viaje: string;
  id_estudiante: string | null;
  tipo_incidente: string;
  severidad: IncidentSeverity;
  descripcion: string;
  coordenadas?: AttendanceCoordinates | null;
  registrado_por_usuario?: string | null;
}

export interface OperationalIncidentRecord {
  id_incidente: string;
  id_viaje: string;
  id_estudiante: string | null;
  tipo_incidente: string;
  severidad: IncidentSeverity;
  descripcion: string;
  coordenadas: AttendanceCoordinates | null;
  fecha_hora: Date;
  registrado_por_usuario: string | null;
}

export interface TripOccupancySummary {
  id_viaje: string;
  id_ruta: string;
  estado: string;
  total_a_bordo: number;
  capacidad_nominal: number;
}

export interface StudentBoardedEventPayload {
  evento: "student:boarded";
  id_viaje: string;
  id_ruta: string;
  id_estudiante: string;
  id_asistencia: string;
  estado_custodia: FsmCustodyState;
  metodo_validacion: BoardingValidationMethod;
  total_a_bordo: number;
  capacidad_nominal: number;
  registrado_por_usuario: string | null;
  coordenadas: AttendanceCoordinates;
  fecha_hora: string;
}

export interface OvercapacityAlertEventPayload {
  evento: "coordination:overcapacity_alert";
  codigo: BoardingResultCode.DENEGADO_SOBRECUPO;
  severidad: "CRITICO";
  id_incidente: string;
  id_viaje: string;
  id_ruta: string;
  id_estudiante: string;
  total_a_bordo: number;
  capacidad_nominal: number;
  registrado_por_usuario: string | null;
  coordenadas: AttendanceCoordinates;
  mensaje: string;
  fecha_hora: string;
}

export class TripNotFoundError extends Error {
  readonly code = "VIAJE_NO_ENCONTRADO";

  constructor(public readonly idViaje: string) {
    super(`El viaje '${idViaje}' no existe.`);
    this.name = "TripNotFoundError";
  }
}

export class TripNotInProgressError extends Error {
  readonly code = "VIAJE_NO_EN_CURSO";

  constructor(
    public readonly idViaje: string,
    public readonly currentState: string,
  ) {
    super(
      `El viaje '${idViaje}' se encuentra en estado '${currentState}' y debe estar 'EN_CURSO' para registrar abordajes.`,
    );
    this.name = "TripNotInProgressError";
  }
}

export class InvalidQrTokenError extends Error {
  constructor(
    public readonly code: "QR_INVALIDO" | "QR_EXPIRADO",
    message: string,
  ) {
    super(message);
    this.name = "InvalidQrTokenError";
  }
}

export class StudentNotAssignedToRouteError extends Error {
  readonly code = "ESTUDIANTE_NO_ASIGNADO_RUTA";

  constructor(
    public readonly idEstudiante: string,
    public readonly idViaje: string,
  ) {
    super(
      `El estudiante '${idEstudiante}' no está asignado a la ruta del viaje '${idViaje}' ni posee pase ocasional aprobado.`,
    );
    this.name = "StudentNotAssignedToRouteError";
  }
}

export class InvalidAttendanceCoordinatesError extends Error {
  readonly code = "COORDENADAS_INVALIDAS";

  constructor(message: string) {
    super(message);
    this.name = "InvalidAttendanceCoordinatesError";
  }
}
