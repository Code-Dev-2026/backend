import {
  CustodyChainVerificationReport,
  CustodyCoordinates,
  CustodyHistoryRecord,
  FsmCustodyState,
  MorningInitializationSummary,
  StudentTripCustodyRecord,
  TripCustodyMeta,
  TripDirection,
} from "./custody.types";

export const CUSTODY_REPOSITORY = Symbol("CUSTODY_REPOSITORY");

export interface PersistCustodyTransitionInput {
  id_viaje: string;
  id_estudiante: string;
  estado_destino: FsmCustodyState;
  tipo_recorrido: TripDirection;
  disparador_evento: string;
  registrado_por_usuario?: string | null;
  coordenadas?: CustodyCoordinates | null;
}

export interface PersistCustodyTransitionResult {
  custody: StudentTripCustodyRecord;
  history: CustodyHistoryRecord;
}

/**
 * Puerto de persistencia para custodia física y ledger WORM (`viaje_estudiante`,
 * `historial_estado_custodia` y cierre de `viaje`).
 */
export interface ICustodyRepository {
  registerTrip(trip: TripCustodyMeta): Promise<TripCustodyMeta>;
  findTripById(idViaje: string): Promise<TripCustodyMeta | null>;

  enrollStudentInTrip(
    idViaje: string,
    idEstudiante: string,
    initialState?: FsmCustodyState,
    esPasajeroOcasional?: boolean,
  ): Promise<StudentTripCustodyRecord>;

  getStudentTripState(
    idViaje: string,
    idEstudiante: string,
  ): Promise<StudentTripCustodyRecord | null>;

  listTripCustodyStates(idViaje: string): Promise<StudentTripCustodyRecord[]>;

  listStudentsByState(
    idViaje: string,
    state: FsmCustodyState,
  ): Promise<StudentTripCustodyRecord[]>;

  applyTransitionAndAppendHistory(
    input: PersistCustodyTransitionInput,
  ): Promise<PersistCustodyTransitionResult>;

  listHistoryByTrip(idViaje: string): Promise<CustodyHistoryRecord[]>;

  listHistoryByStudent(
    idEstudiante: string,
    limit?: number,
  ): Promise<CustodyHistoryRecord[]>;

  verifyHistoryIntegrity(limit?: number): Promise<CustodyChainVerificationReport>;

  initializeMorningCustody(fecha: string): Promise<MorningInitializationSummary>;

  finalizeTrip(idViaje: string): Promise<TripCustodyMeta>;
}
