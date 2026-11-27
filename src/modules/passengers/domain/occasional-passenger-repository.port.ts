import {
  ApproveOccasionalSeatCommand,
  ApproveOccasionalSeatResult,
  OccasionalPassengerRecord,
  RequestOccasionalSeatCommand,
  RequestOccasionalSeatResult,
  TripManifestEntry,
  VacancyBalanceSnapshot,
} from "./occasional-passenger.types";

export const OCCASIONAL_PASSENGER_REPOSITORY = Symbol(
  "OCCASIONAL_PASSENGER_REPOSITORY",
);

/**
 * Puerto hexagonal de persistencia transaccional para gestión de pasajeros ocasionales
 * y reasignación atómica de cupos liberados por inasistencia (Issue #11).
 */
export interface IOccasionalPassengerRepository {
  evaluateTripVacancyBalance(idViaje: string): Promise<VacancyBalanceSnapshot>;

  requestOccasionalSeat(
    command: RequestOccasionalSeatCommand,
  ): Promise<RequestOccasionalSeatResult>;

  approveOccasionalSeat(
    command: ApproveOccasionalSeatCommand,
  ): Promise<ApproveOccasionalSeatResult>;

  /**
   * Intenta revertir una inasistencia reportada. Debe fallar con `AbsenceIrreversibleError`
   * si el cupo liberado ya fue asignado a un pasajero ocasional activo (política del colegio).
   */
  revertAbsence(idViaje: string, idEstudiante: string): Promise<void>;

  findRequestById(
    idPasajeroOcasional: string,
  ): Promise<OccasionalPassengerRecord | null>;

  listTripPassengerManifest(idViaje: string): Promise<TripManifestEntry[]>;
}
