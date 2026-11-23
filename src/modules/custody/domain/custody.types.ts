import { CustodyStateEnum } from "@common/enums/custody-state.enum";
import { TripStateEnum } from "@common/enums/trip-state.enum";

/**
 * Estados oficiales de la máquina de estados finitos (FSM) de custodia física (Issue #7).
 * Unidireccionales y alineados con V014 (`viaje_estudiante.estado_custodia`).
 */
export enum FsmCustodyState {
  NO_INICIADO = CustodyStateEnum.NO_INICIADO,
  EN_ESPERA_ABORDAJE = CustodyStateEnum.EN_ESPERA_ABORDAJE,
  A_BORDO_VEHICULO = CustodyStateEnum.A_BORDO_VEHICULO,
  EN_COLEGIO = CustodyStateEnum.EN_COLEGIO,
  ENTREGADO_ACUDIENTE = CustodyStateEnum.ENTREGADO_ACUDIENTE,
  RETORNO_SEDE_POR_FALLA_ENTREGA = CustodyStateEnum.RETORNO_SEDE_POR_FALLA_ENTREGA,
}

export const ALL_FSM_CUSTODY_STATES: readonly FsmCustodyState[] = Object.freeze([
  FsmCustodyState.NO_INICIADO,
  FsmCustodyState.EN_ESPERA_ABORDAJE,
  FsmCustodyState.A_BORDO_VEHICULO,
  FsmCustodyState.EN_COLEGIO,
  FsmCustodyState.ENTREGADO_ACUDIENTE,
  FsmCustodyState.RETORNO_SEDE_POR_FALLA_ENTREGA,
]);

export enum TripDirection {
  MANANA = "MANANA",
  TARDE = "TARDE",
}

export const ALL_TRIP_DIRECTIONS: readonly TripDirection[] = Object.freeze([
  TripDirection.MANANA,
  TripDirection.TARDE,
]);

export const CUSTODY_GENESIS_HASH =
  "0000000000000000000000000000000000000000000000000000000000000000";

export function isFsmCustodyState(value: string): value is FsmCustodyState {
  return (ALL_FSM_CUSTODY_STATES as readonly string[]).includes(value);
}

export function isTripDirection(value: string): value is TripDirection {
  return (ALL_TRIP_DIRECTIONS as readonly string[]).includes(value);
}

export interface CustodyCoordinates {
  latitud: number;
  longitud: number;
}

export interface StudentTripCustodyRecord {
  id_viaje: string;
  id_estudiante: string;
  estado_custodia: FsmCustodyState;
  es_pasajero_ocasional: boolean;
  hora_abordaje: Date | null;
  hora_desembarque: Date | null;
  actualizado_en: Date;
}

export interface CustodyHistoryRecord {
  id_historial: string;
  secuencia: number;
  id_estudiante: string;
  id_viaje: string;
  estado_origen: FsmCustodyState;
  estado_destino: FsmCustodyState;
  disparador_evento: string;
  coordenadas_gps: CustodyCoordinates | null;
  fecha_hora: Date;
  registrado_por_usuario: string | null;
  hash_sha256_anterior: string;
  hash_sha256_actual: string;
}

export interface CustodyIntegrityCheckRow {
  secuencia: number;
  es_valido: boolean;
  hash_esperado: string;
  hash_encontrado: string;
}

export interface CustodyChainVerificationReport {
  total_verificados: number;
  cadena_integra: boolean;
  secuencia_fallo: number | null;
  registros: CustodyIntegrityCheckRow[];
}

export interface TripCustodyMeta {
  id_viaje: string;
  id_ruta: string;
  fecha: string;
  tipo_recorrido: TripDirection;
  estado: TripStateEnum;
  hora_fin_real?: Date | null;
}

export interface MorningInitializationEntry {
  id_viaje: string;
  id_estudiante: string;
  estado_custodia: FsmCustodyState;
}

export interface MorningInitializationSummary {
  fecha: string;
  registros_inicializados: number;
  registros: MorningInitializationEntry[];
}

export class CustodyInvariantViolationError extends Error {
  readonly code = "CUSTODY_FSM_INVARIANT_VIOLATION";

  constructor(
    public readonly fromState: string,
    public readonly toState: string,
    public readonly tripDirection: string,
    public readonly allowedTargets: readonly FsmCustodyState[],
    customMessage?: string,
  ) {
    super(
      customMessage ??
        `Violación de invariante FSM de custodia: transición inválida de '${fromState}' a '${toState}' para recorrido '${tripDirection}'. Destinos permitidos: [${allowedTargets.join(", ") || "ninguno"}].`,
    );
    this.name = "CustodyInvariantViolationError";
  }
}

export class TripClosureBlockedError extends Error {
  readonly code = "TRIP_CLOSURE_BLOCKED_STUDENTS_ON_BOARD";

  constructor(
    public readonly idViaje: string,
    public readonly studentsOnBoardCount: number,
    public readonly studentIds: readonly string[] = [],
  ) {
    super(
      `No se puede finalizar el viaje '${idViaje}' (FINALIZADO): existen ${studentsOnBoardCount} estudiante(s) aún en estado A_BORDO_VEHICULO.`,
    );
    this.name = "TripClosureBlockedError";
  }
}

export class WormImmutabilityViolationError extends Error {
  readonly code = "WORM_IMMUTABILITY_VIOLATION";

  constructor(
    message = "Violación WORM (ASVS V1.14): historial_estado_custodia es estrictamente inmutable (append-only). No se permite UPDATE, DELETE ni TRUNCATE.",
  ) {
    super(message);
    this.name = "WormImmutabilityViolationError";
  }
}

export class CustodyEnrollmentNotFoundError extends Error {
  readonly code = "CUSTODY_ENROLLMENT_NOT_FOUND";

  constructor(
    public readonly idViaje: string,
    public readonly idEstudiante: string,
  ) {
    super(
      `El estudiante '${idEstudiante}' no cuenta con matrícula operativa en el viaje '${idViaje}'.`,
    );
    this.name = "CustodyEnrollmentNotFoundError";
  }
}

export class InvalidCustodyCoordinatesError extends Error {
  readonly code = "INVALID_CUSTODY_COORDINATES";

  constructor(message: string) {
    super(message);
    this.name = "InvalidCustodyCoordinatesError";
  }
}
