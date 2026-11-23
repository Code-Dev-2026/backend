import {
  OvercapacityAlertEventPayload,
  StudentBoardedEventPayload,
} from "./attendance.types";

export const ATTENDANCE_REALTIME_PORT = Symbol("ATTENDANCE_REALTIME_PORT");

/**
 * Puerto de emisión en tiempo real vía Socket.IO para eventos de abordaje y alertas de sobrecupo (Issue #8).
 */
export interface IAttendanceRealtimePort {
  emitStudentBoarded(payload: StudentBoardedEventPayload): Promise<void>;
  emitOvercapacityAlert(payload: OvercapacityAlertEventPayload): Promise<void>;
}
