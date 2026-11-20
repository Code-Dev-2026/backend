/**
 * Puerto de auditoría de seguridad del módulo de identidad (DIP).
 * El adaptador concreto escribe en la bitácora forense del sistema.
 */
export interface SecurityIncident {
  tipo_evento: string;
  id_usuario?: string;
  payload: Record<string, unknown>;
}

export interface ISecurityAuditPort {
  registrarIncidente(incidente: SecurityIncident): Promise<void>;
}

export const SECURITY_AUDIT = Symbol("ISecurityAuditPort");
