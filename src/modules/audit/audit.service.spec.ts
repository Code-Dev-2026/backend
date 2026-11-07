import { AuditService } from "./audit.service";

describe("AuditService (Sprint 4 - WORM)", () => {
  let service: AuditService;

  beforeEach(() => {
    service = new AuditService();
  });

  it("debe registrar un evento crítico y encadenar el hash SHA-256", async () => {
    const event1 = await service.logCriticalEvent({
      tipo_evento: "QR_SCAN",
      id_usuario: "user-1",
      id_estudiante: "est-1",
      payload: { lat: 4.81, lng: -75.69 },
    });

    expect(event1.hash_evento).toBeDefined();
    expect(event1.hash_evento.length).toBe(64);
    expect(event1.inmutable).toBe(true);

    const event2 = await service.logCriticalEvent({
      tipo_evento: "CUSTODY_TRANSITION",
      id_usuario: "user-1",
      id_estudiante: "est-1",
      payload: { to: "A_BORDO_VEHICULO" },
    });

    expect(event2.hash_anterior).toBe(event1.hash_evento);
    expect(event2.hash_evento.length).toBe(64);
  });
});
