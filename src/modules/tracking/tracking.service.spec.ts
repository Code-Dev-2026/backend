import { TrackingService } from "./tracking.service";

describe("TrackingService (Sprint 3)", () => {
  let service: TrackingService;

  beforeEach(() => {
    service = new TrackingService();
  });

  it("debe obtener estado de tracking en vivo y ETA", async () => {
    const result = await service.getLiveTripTracking("trip-1");
    expect(result.id_viaje).toBe("trip-1");
    expect(result.eta_minutos).toBe(4);
    expect(result.estado_geocerca).toBe("EN_RUTA_NORMAL");
  });
});
