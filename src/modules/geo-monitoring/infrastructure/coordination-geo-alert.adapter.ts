import { Injectable, Logger } from "@nestjs/common";
import {
  AttendanceRealtimeGateway,
  COORDINATION_ALERT_ROOM,
} from "../../attendance/infrastructure/attendance-realtime.gateway";
import { COORDINATION_ROUTE_SECURITY_ALERT_EVENT } from "../domain/geo-monitoring.constants";
import { RouteSecurityAlertPayload } from "../domain/geo-monitoring.types";
import { IGeoSecurityAlertPort } from "../domain/geo-security-alert.port";

/**
 * Adaptador Socket.IO de alertas críticas geoespaciales (Issue #13).
 *
 * Reutiliza el servidor y la sala `coordinacion` de `AttendanceRealtimeGateway`
 * (namespace `/asistencia`, Issues #8–#10) para que Coordinación reciba todas sus
 * alertas por un único canal, sin modificar el gateway existente.
 */
@Injectable()
export class CoordinationGeoAlertAdapter implements IGeoSecurityAlertPort {
  private readonly logger = new Logger(CoordinationGeoAlertAdapter.name);

  constructor(private readonly gateway: AttendanceRealtimeGateway) {}

  async emitRouteSecurityAlert(
    payload: RouteSecurityAlertPayload,
  ): Promise<boolean> {
    const server = this.gateway.server;
    if (!server) {
      this.logger.warn(
        `[Socket.IO pendiente] ${COORDINATION_ROUTE_SECURITY_ALERT_EVENT} viaje=${payload.id_viaje} incidente=${payload.id_incidente}`,
      );
      return false;
    }

    server
      .to(COORDINATION_ALERT_ROOM)
      .emit(COORDINATION_ROUTE_SECURITY_ALERT_EVENT, payload);
    this.logger.warn(
      `[Socket.IO] Emitida ${COORDINATION_ROUTE_SECURITY_ALERT_EVENT} (${payload.tipo_incidente}) a '${COORDINATION_ALERT_ROOM}' viaje=${payload.id_viaje} incidente=${payload.id_incidente}`,
    );
    return true;
  }
}
