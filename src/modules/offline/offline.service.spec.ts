import { BadRequestException } from "@nestjs/common";
import { OfflineService } from "./offline.service";

describe("OfflineService (Sprint 4)", () => {
  let service: OfflineService;

  beforeEach(() => {
    service = new OfflineService();
  });

  it("debe procesar lote offline con idempotency_key", async () => {
    const result = await service.processOfflineBatch({
      id_dispositivo: "terminal-01",
      idempotency_key: "idem-uuid-1234",
      eventos: [
        {
          tipo: "BOARDING",
          payload: { id_estudiante: "est-1" },
          timestamp_local: new Date().toISOString(),
        },
      ],
    });

    expect(result.estado).toBe("RECONCILIADO_EXITOSAMENTE");
    expect(result.total_eventos).toBe(1);
    expect(result.idempotency_key).toBe("idem-uuid-1234");
  });

  it("debe arrojar BadRequestException si falta la idempotency_key", async () => {
    await expect(
      service.processOfflineBatch({
        id_dispositivo: "terminal-01",
        idempotency_key: "",
        eventos: [],
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
