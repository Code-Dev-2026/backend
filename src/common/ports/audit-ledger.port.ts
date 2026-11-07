import { AuditActionEnum } from "../enums/audit-action.enum";

export interface AuditRecordPayload {
  tabla: string;
  id_registro: string;
  accion: AuditActionEnum | string;
  id_usuario?: string;
  datos_anteriores?: Record<string, unknown>;
  datos_nuevos?: Record<string, unknown>;
  ip_origen?: string;
  user_agent?: string;
}

/**
 * Puerto de Dominio: Bitácora Forense Inmutable WORM (ADR-002)
 */
export interface IAuditLedgerPort {
  recordAudit(
    payload: AuditRecordPayload,
  ): Promise<{ id_auditoria: string; hash_actual: string }>;
  verifyChainIntegrity(tabla: string): Promise<boolean>;
}
