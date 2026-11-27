import { TripStateEnum } from "@common/enums/trip-state.enum";
import { FsmCustodyState } from "../../custody/domain/custody.types";

export enum OccasionalRequestStatus {
  RADICADA = "RADICADA",
  APROBADO_COORDINACION = "APROBADO_COORDINACION",
  RECHAZADA = "RECHAZADA",
  UTILIZADO = "UTILIZADO",
}

export enum OccasionalRejectionReason {
  ANTELACION_INSUFICIENTE = "ANTELACION_INSUFICIENTE",
  SIN_VACANTE_POR_INASISTENCIA = "SIN_VACANTE_POR_INASISTENCIA",
  CAPACIDAD_NOMINAL_AGOTADA = "CAPACIDAD_NOMINAL_AGOTADA",
}

export interface VacancyBalanceSnapshot {
  id_viaje: string;
  id_ruta: string;
  estado_viaje: TripStateEnum | string;
  hora_inicio_programada: Date;
  capacidad_nominal: number;
  estudiantes_asignados: number;
  inasistencias_reportadas: number;
  ocasionales_activos: number;
  ocupacion_proyectada: number;
  inasistencias_disponibles: number;
  cupo_nominal_disponible: number;
  vacantes_netas: number;
}

export interface LeadTimeEvaluation {
  cumple_antelacion: boolean;
  minutos_antelacion: number;
  horas_antelacion: number;
  minimo_horas_requerido: number;
  hora_inicio_programada: Date;
  solicitado_en: Date;
  hora_limite_solicitud: Date;
}

export interface OccasionalEligibilityEvaluation {
  elegible: boolean;
  motivos_rechazo: OccasionalRejectionReason[];
  antelacion: LeadTimeEvaluation;
  balance_vacantes: VacancyBalanceSnapshot;
  mensaje: string;
}

export interface OccasionalPassengerRecord {
  id_pasajero_ocasional: string;
  id_estudiante: string;
  id_viaje: string;
  id_ruta: string;
  id_estudiante_que_libera_cupo: string;
  qr_provisional_hash: string;
  estado_solicitud: OccasionalRequestStatus;
  solicitado_en: Date;
  solicitado_por_acudiente: string | null;
  motivo: string | null;
  aprobado_en: Date | null;
  aprobado_por_coordinador: string | null;
}

export interface TripManifestEntry {
  id_viaje: string;
  id_estudiante: string;
  estado_custodia: FsmCustodyState;
  es_pasajero_ocasional: boolean;
}

export interface RequestOccasionalSeatCommand {
  id_viaje: string;
  id_estudiante: string;
  solicitado_por_usuario: string;
  qr_provisional_hash: string;
  motivo?: string | null;
  solicitado_en: Date;
}

export interface RequestOccasionalSeatResult {
  solicitud: OccasionalPassengerRecord;
  hora_inicio_programada: Date;
  balance_vacantes: VacancyBalanceSnapshot;
}

export interface ApproveOccasionalSeatCommand {
  id_pasajero_ocasional: string;
  aprobado_por_usuario: string;
  id_coordinador?: string | null;
}

export interface ApproveOccasionalSeatResult {
  solicitud: OccasionalPassengerRecord;
  lista_asistencia: TripManifestEntry;
  balance_vacantes: VacancyBalanceSnapshot;
}

// ============================================================================
// EXCEPCIONES DE DOMINIO TIPADAS (Issue #11)
// ============================================================================

export class OccasionalTripNotFoundError extends Error {
  readonly code = "VIAJE_NO_ENCONTRADO";
  constructor(idViaje: string) {
    super(`El viaje ${idViaje} no existe.`);
    this.name = "OccasionalTripNotFoundError";
  }
}

export class OccasionalTripNotScheduledError extends Error {
  readonly code = "VIAJE_NO_PROGRAMADO";
  constructor(idViaje: string, estado: string) {
    super(
      `El viaje ${idViaje} se encuentra en estado ${estado} y solo se permiten reservas ocasionales en viajes PROGRAMADO.`,
    );
    this.name = "OccasionalTripNotScheduledError";
  }
}

export class OccasionalStudentNotFoundError extends Error {
  readonly code = "ESTUDIANTE_NO_ENCONTRADO";
  constructor(idEstudiante: string) {
    super(`El estudiante ${idEstudiante} no existe o se encuentra inactivo.`);
    this.name = "OccasionalStudentNotFoundError";
  }
}

export class GuardianNotAuthorizedForStudentError extends Error {
  readonly code = "ACUDIENTE_NO_AUTORIZADO_PARA_ESTUDIANTE";
  constructor(idUsuario: string, idEstudiante: string) {
    super(
      `Autorización denegada (OWASP ASVS V4.1): el usuario ${idUsuario} no es acudiente registrado del estudiante ${idEstudiante}.`,
    );
    this.name = "GuardianNotAuthorizedForStudentError";
  }
}

export class StudentAlreadyAssignedToRouteError extends Error {
  readonly code = "ESTUDIANTE_YA_ASIGNADO_A_RUTA";
  constructor(idEstudiante: string, idRuta: string) {
    super(
      `El estudiante ${idEstudiante} ya cuenta con asignación regular activa en la ruta ${idRuta}.`,
    );
    this.name = "StudentAlreadyAssignedToRouteError";
  }
}

export class DuplicateOccasionalRequestError extends Error {
  readonly code = "SOLICITUD_DUPLICADA";
  constructor(idEstudiante: string, idViaje: string) {
    super(
      `El estudiante ${idEstudiante} ya tiene una solicitud ocasional activa o matrícula registrada en el viaje ${idViaje}.`,
    );
    this.name = "DuplicateOccasionalRequestError";
  }
}

export class OccasionalBookingRulesViolationError extends Error {
  readonly code = "REGLAS_PASAJERO_OCASIONAL_INCUMPLIDAS";
  readonly motivos_rechazo: OccasionalRejectionReason[];
  readonly detalle_antelacion?: LeadTimeEvaluation;
  readonly balance_vacantes?: VacancyBalanceSnapshot;

  constructor(params: {
    motivos_rechazo: OccasionalRejectionReason[];
    message: string;
    detalle_antelacion?: LeadTimeEvaluation;
    balance_vacantes?: VacancyBalanceSnapshot;
  }) {
    super(params.message);
    this.name = "OccasionalBookingRulesViolationError";
    this.motivos_rechazo = params.motivos_rechazo;
    this.detalle_antelacion = params.detalle_antelacion;
    this.balance_vacantes = params.balance_vacantes;
  }
}

export class OccasionalRequestNotFoundError extends Error {
  readonly code = "SOLICITUD_NO_ENCONTRADA";
  constructor(idSolicitud: string) {
    super(`La solicitud de pasajero ocasional ${idSolicitud} no existe.`);
    this.name = "OccasionalRequestNotFoundError";
  }
}

export class OccasionalRequestInvalidStateError extends Error {
  readonly code = "SOLICITUD_ESTADO_INVALIDO";
  constructor(idSolicitud: string, estado: string) {
    super(
      `La solicitud ${idSolicitud} se encuentra en estado ${estado} y solo puede aprobarse desde RADICADA.`,
    );
    this.name = "OccasionalRequestInvalidStateError";
  }
}

export class CoordinatorNotAuthorizedForTripError extends Error {
  readonly code = "COORDINADOR_NO_AUTORIZADO";
  constructor(idRuta: string) {
    super(
      `El coordinador autenticado no está acreditado para aprobar pasajeros ocasionales en el colegio de la ruta ${idRuta}.`,
    );
    this.name = "CoordinatorNotAuthorizedForTripError";
  }
}

export class AbsenceIrreversibleError extends Error {
  readonly code = "INASISTENCIA_IRREVERSIBLE_CUPO_ASIGNADO";
  constructor(idEstudiante: string, idViaje: string) {
    super(
      `La inasistencia confirmada del estudiante ${idEstudiante} en el viaje ${idViaje} no puede revertirse porque el cupo ya fue legalmente asignado a un pasajero ocasional.`,
    );
    this.name = "AbsenceIrreversibleError";
  }
}

export class OccasionalTransactionError extends Error {
  readonly code = "ERROR_TRANSACCION_PASAJERO_OCASIONAL";
  constructor(message: string) {
    super(message);
    this.name = "OccasionalTransactionError";
  }
}
