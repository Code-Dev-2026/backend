import {
  AtomicBoardingCommand,
  AtomicBoardingRecord,
  CreateOperationalIncidentInput,
  OperationalIncidentRecord,
  TripOccupancySummary,
} from "./attendance.types";
import {
  AtomicDisembarkCommand,
  AtomicDisembarkRecord,
  CustodyActaRecord,
  DeliveryRecord,
  FinalizeSchoolCustodyCommand,
  FinalizeSchoolCustodyRecord,
  SchoolCoordinatorRecord,
  StudentReceptorDirectory,
} from "./disembark.types";

export const ATTENDANCE_REPOSITORY = Symbol("ATTENDANCE_REPOSITORY");

/**
 * Puerto de persistencia transaccional para abordaje QR, desembarque seguro,
 * validación de receptores, actas en sede e incidentes (Issues #8 y #9).
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

  // ---- Extensión Issue #9: Desembarque seguro, receptores y cierre en sede ----

  getTripDirection(idViaje: string): Promise<"MANANA" | "TARDE" | null>;

  getStudentReceptorDirectory(
    idEstudiante: string,
  ): Promise<StudentReceptorDirectory | null>;

  getSchoolCoordinator(
    idCoordinador: string,
  ): Promise<SchoolCoordinatorRecord | null>;

  registerAtomicDisembark(
    command: AtomicDisembarkCommand,
  ): Promise<AtomicDisembarkRecord>;

  finalizeSchoolCustody(
    command: FinalizeSchoolCustodyCommand,
  ): Promise<FinalizeSchoolCustodyRecord>;

  listStudentDeliveries(
    idViaje: string,
    idEstudiante?: string,
  ): Promise<DeliveryRecord[]>;

  getCustodyActaByDelivery(
    idEntrega: string,
  ): Promise<CustodyActaRecord | null>;
}
