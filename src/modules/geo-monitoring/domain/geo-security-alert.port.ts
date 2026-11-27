import { RouteSecurityAlertPayload } from "./geo-monitoring.types";

export const GEO_SECURITY_ALERT_PORT = Symbol("GEO_SECURITY_ALERT_PORT");

/** Puerto de emisión inmediata de alertas críticas a Coordinación (Issue #13). */
export interface IGeoSecurityAlertPort {
  emitRouteSecurityAlert(payload: RouteSecurityAlertPayload): Promise<boolean>;
}
