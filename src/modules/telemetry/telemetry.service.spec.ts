import { TelemetryService } from "./telemetry.service";

describe("TelemetryService (Sprint 3)", () => {
  let service: TelemetryService;

  beforeEach(() => {
    service = new TelemetryService();
  });

  it("debe procesar paquete telemático GPS", async () => {
    const result = await service.processGpsTelemetry({
      id_viaje: "trip-1",
      id_vehiculo: "veh-1",
      latitud: 4.814,
      longitud: -75.694,
      velocidad_kmh: 40,
      rumbo: 90,
      timestamp: new Date().toISOString(),
    });

    expect(result.recibido).toBe(true);
    expect(result.desviacion_metros).toBe(45);
    expect(result.alerta_desvio).toBe(false);
  });

  it("debe sincronizar lotes offline", async () => {
    const result = await service.syncOfflineBatch("dev-1", [{}, {}]);
    expect(result.eventos_procesados).toBe(2);
    expect(result.estado_sync).toBe("COMPLETADO_IDEMPOTENTE");
  });
});
