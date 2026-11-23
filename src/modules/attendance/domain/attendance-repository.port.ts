import {
  AtomicBoardingCommand,
  AtomicBoardingRecord,
  CreateOperationalIncidentInput,
  OperationalIncidentRecord,
  TripOccupancySummary,
} from "./attendance.types";

export const ATTENDANCE_REPOSITORY = Symbol("ATTENDANCE_REPOSITORY");

/**
 * Puerto de persistencia transaccional para abordaje QR atómico e incidentes (Issue #8).
 */
export interface IAttendanceRepository {
  registerAtomicBoarding(
    command: AtomicBoardingCommand,
  ): Promise<AtomicBoardingRecord>;

  recordIncident(
    input: CreateOperationalIncidentInput,
  ): Promise<OperationalIncidentRecord>;

  listTripIncidents(idViaje: string): Promise<OperationalIncidentRecord[]>;

  getTripOccupancy(idViaje: string): Promise<TripOccupancySummary | null>;
}
