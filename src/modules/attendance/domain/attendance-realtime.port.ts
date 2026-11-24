import {
  OvercapacityAlertEventPayload,
  StudentBoardedEventPayload,
} from "./attendance.types";
import {
  FailedDeliveryAlertEventPayload,
  SchoolCustodyFinalizedEventPayload,
  StudentDisembarkedEventPayload,
  UnauthorizedReceptorAlertEventPayload,
} from "./disembark.types";

export const ATTENDANCE_REALTIME_PORT = Symbol("ATTENDANCE_REALTIME_PORT");

/**
 * Puerto de emisión en tiempo real vía Socket.IO para eventos de abordaje,
 * desembarque seguro, alertas de sobrecupo y protocolo de retorno a sede (Issues #8 y #9).
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
  emitSchoolCustodyFinalized?(
    payload: SchoolCustodyFinalizedEventPayload,
  ): Promise<void>;
}
