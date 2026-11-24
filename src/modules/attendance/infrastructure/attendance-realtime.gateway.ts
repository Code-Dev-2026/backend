import { Injectable, Logger } from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";
import { IAttendanceRealtimePort } from "../domain/attendance-realtime.port";
import {
  OvercapacityAlertEventPayload,
  StudentBoardedEventPayload,
} from "../domain/attendance.types";
import {
  FailedDeliveryAlertEventPayload,
  SchoolCustodyFinalizedEventPayload,
  StudentDisembarkedEventPayload,
  UnauthorizedReceptorAlertEventPayload,
} from "../domain/disembark.types";

export const COORDINATION_ALERT_ROOM = "coordinacion";

/**
 * Pasarela WebSocket Socket.IO para eventos de abordaje en tiempo real (Issue #8).
 *
 * - Emite `student:boarded` inmediatamente tras cada abordaje atómico confirmado.
 * - Emite `coordination:overcapacity_alert` a la sala de Coordinación cuando ocurre `DENEGADO_SOBRECUPO`.
 */
@Injectable()
@WebSocketGateway({
  namespace: "/asistencia",
  cors: {
    origin: true,
    credentials: true,
  },
})
export class AttendanceRealtimeGateway implements IAttendanceRealtimePort {
  private readonly logger = new Logger(AttendanceRealtimeGateway.name);

  @WebSocketServer()
  server?: Server;

  @SubscribeMessage("subscribe:trip")
  async handleSubscribeTrip(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { id_viaje?: string },
  ): Promise<{ subscribed: boolean; room: string | null }> {
    const idViaje = payload?.id_viaje?.trim();
    if (!idViaje) {
      return { subscribed: false, room: null };
    }
    const room = `viaje:${idViaje}`;
    await client.join(room);
    return { subscribed: true, room };
  }

  @SubscribeMessage("subscribe:coordination")
  async handleSubscribeCoordination(
    @ConnectedSocket() client: Socket,
  ): Promise<{ subscribed: boolean; room: string }> {
    await client.join(COORDINATION_ALERT_ROOM);
    return { subscribed: true, room: COORDINATION_ALERT_ROOM };
  }

  async emitStudentBoarded(
    payload: StudentBoardedEventPayload,
  ): Promise<void> {
    if (!this.server) {
      this.logger.debug(
        `[Socket.IO pendiente] student:boarded viaje=${payload.id_viaje} estudiante=${payload.id_estudiante}`,
      );
      return;
    }

    this.server.emit("student:boarded", payload);
    this.logger.log(
      `[Socket.IO] Emitido student:boarded viaje=${payload.id_viaje} aforo=${payload.total_a_bordo}/${payload.capacidad_nominal}`,
    );
  }

  async emitOvercapacityAlert(
    payload: OvercapacityAlertEventPayload,
  ): Promise<void> {
    if (!this.server) {
      this.logger.warn(
        `[Socket.IO pendiente] coordination:overcapacity_alert viaje=${payload.id_viaje} incidente=${payload.id_incidente}`,
      );
      return;
    }

    this.server
      .to(COORDINATION_ALERT_ROOM)
      .emit("coordination:overcapacity_alert", payload);
    this.logger.warn(
      `[Socket.IO] Emitida alerta de sobrecupo a '${COORDINATION_ALERT_ROOM}' viaje=${payload.id_viaje} incidente=${payload.id_incidente}`,
    );
  }

  async emitStudentDisembarked(
    payload: StudentDisembarkedEventPayload,
  ): Promise<void> {
    if (!this.server) {
      this.logger.debug(
        `[Socket.IO pendiente] student:disembarked viaje=${payload.id_viaje} estudiante=${payload.id_estudiante}`,
      );
      return;
    }

    this.server.emit("student:disembarked", payload);
    this.logger.log(
      `[Socket.IO] Emitido student:disembarked viaje=${payload.id_viaje} aforo=${payload.total_a_bordo}/${payload.capacidad_nominal}`,
    );
  }

  async emitFailedDeliveryAlert(
    payload: FailedDeliveryAlertEventPayload,
  ): Promise<void> {
    if (!this.server) {
      this.logger.warn(
        `[Socket.IO pendiente] coordination:failed_delivery_alert viaje=${payload.id_viaje} incidente=${payload.id_incidente}`,
      );
      return;
    }

    this.server
      .to(COORDINATION_ALERT_ROOM)
      .emit("coordination:failed_delivery_alert", payload);
    this.logger.warn(
      `[Socket.IO] Emitida alerta de retorno seguro a '${COORDINATION_ALERT_ROOM}' viaje=${payload.id_viaje} estudiante=${payload.id_estudiante}`,
    );
  }

  async emitUnauthorizedReceptorAlert(
    payload: UnauthorizedReceptorAlertEventPayload,
  ): Promise<void> {
    if (!this.server) {
      this.logger.warn(
        `[Socket.IO pendiente] coordination:unauthorized_receptor_alert viaje=${payload.id_viaje} codigo=${payload.codigo}`,
      );
      return;
    }

    this.server
      .to(COORDINATION_ALERT_ROOM)
      .emit("coordination:unauthorized_receptor_alert", payload);
  }

  async emitSchoolCustodyFinalized(
    payload: SchoolCustodyFinalizedEventPayload,
  ): Promise<void> {
    if (!this.server) {
      this.logger.debug(
        `[Socket.IO pendiente] custody:school_return_completed viaje=${payload.id_viaje} acta=${payload.id_acta}`,
      );
      return;
    }

    this.server.emit("custody:school_return_completed", payload);
    this.logger.log(
      `[Socket.IO] Emitido custody:school_return_completed viaje=${payload.id_viaje} acta=${payload.id_acta}`,
    );
  }
}
