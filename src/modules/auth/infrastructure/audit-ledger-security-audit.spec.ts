import { AuditService } from "../../audit/audit.service";
import { AuditLedgerSecurityAudit } from "./audit-ledger-security-audit";

describe("AuditLedgerSecurityAudit", () => {
  it("traduce el incidente a un evento crítico de la bitácora forense", async () => {
    const logCriticalEvent = jest.fn().mockResolvedValue(undefined);
    const adapter = new AuditLedgerSecurityAudit({
      logCriticalEvent,
    } as unknown as AuditService);

    await adapter.registrarIncidente({
      tipo_evento: "REFRESH_TOKEN_REUSE_DETECTED",
      id_usuario: "u1",
      payload: { family_id: "f1" },
    });

    expect(logCriticalEvent).toHaveBeenCalledWith({
      tipo_evento: "REFRESH_TOKEN_REUSE_DETECTED",
      id_usuario: "u1",
      payload: { family_id: "f1" },
    });
  });
});
