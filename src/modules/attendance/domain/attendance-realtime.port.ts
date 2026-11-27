import {
  OvercapacityAlertEventPayload,
  StudentBoardedEventPayload,
} from "./attendance.types";
import {
  FailedDeliveryAlertEventPayload,
  JudicialAlertEventPayload,
  SchoolCustodyFinalizedEventPayload,
  StudentDisembarkedEventPayload,
  UnauthorizedReceptorAlertEventPayload,
} from "./disembark.types";

export const ATTENDANCE_REALTIME_PORT = Symbol("ATTENDANCE_REALTIME_PORT");

/**
 * Puerto de emisión en tiempo real vía Socket.IO para eventos de abordaje,
 * desembarque seguro, alertas de sobrecupo, alertas judiciales y retorno a sede (Issues #8, #9 y #10).
 */
export interface IAttendanceRealtimePort {
  emitStudentBoarded(payload: StudentBoardedEventPayload): Promise<void>;
  emitOvercapacityAlert(payload: OvercapacityAlertEventPayload): Promise<void>;
  emitStudentDisembarked?(
    payload: StudentDisembarkedEventPayload,
  ): Promise<void>;
  emitFailedDeliveryAlert?(
    payload: FailedDeliveryAlertEventPayload,
  ): Promise<void>;
  emitUnauthorizedReceptorAlert?(
    payload: UnauthorizedReceptorAlertEventPayload,
  ): Promise<void>;
  emitJudicialAlert?(payload: JudicialAlertEventPayload): Promise<void>;
  emitSchoolCustodyFinalized?(
    payload: SchoolCustodyFinalizedEventPayload,
  ): Promise<void>;
}
