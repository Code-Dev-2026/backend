import { BillingIsolationService } from "./billing-isolation.service";

describe("BillingIsolationService (Sprint 4 - RN-05 Inmunidad Operativa)", () => {
  let service: BillingIsolationService;

  beforeEach(() => {
    service = new BillingIsolationService();
  });

  it("debe confirmar que el servicio de ruta NUNCA se bloquea por mora (RN-05)", async () => {
    const status = await service.getStudentBillingStatus("est-1");
    expect(status.bloquea_servicio_ruta).toBe(false);
    expect(status.id_estudiante).toBe("est-1");
  });
});
