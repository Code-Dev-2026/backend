import { Injectable } from "@nestjs/common";
import { AuditService } from "../../audit/audit.service";
import {
  ISecurityAuditPort,
  SecurityIncident,
} from "../domain/security-audit.port";

/** Adaptador: registra incidentes de seguridad en la bitácora forense. */
@Injectable()
export class AuditLedgerSecurityAudit implements ISecurityAuditPort {
  constructor(private readonly auditService: AuditService) {}

  async registrarIncidente(incidente: SecurityIncident): Promise<void> {
    await this.auditService.logCriticalEvent({
      tipo_evento: incidente.tipo_evento,
      id_usuario: incidente.id_usuario,
      payload: incidente.payload,
    });
  }
}
