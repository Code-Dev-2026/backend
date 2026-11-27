import { ConfigService } from "@nestjs/config";
import {
  ITelemetryIngestPort,
  TelemetryEnvelopeHandler,
} from "./domain/telemetry-ingest.port";
import {
  formatGpsPartitionName,
  RawTelemetryEnvelope,
  TELEMETRY_GPS_RECORDED_EVENT,
  TelemetryIngestResult,
  TelemetryRecordedEventPayload,
} from "./domain/telemetry.types";
import { InMemoryEventDispatcher } from "./infrastructure/in-memory-event-dispatcher";
import { InMemoryTelemetryRepository } from "./infrastructure/in-memory-telemetry.repository";
import { TelemetryIngestChannel } from "./infrastructure/telemetry-ingest.channel";
import { TelemetryPacketValidator } from "./telemetry-packet.validator";
import { TelemetryPartitionMaintenanceJob } from "./telemetry-partition-maintenance.job";
import { TelemetryService } from "./telemetry.service";

class SimulatorTelemetryIngestAdapter implements ITelemetryIngestPort {
  private handler: TelemetryEnvelopeHandler | null = null;

  registerHandler(handler: TelemetryEnvelopeHandler): void {
    this.handler = handler;
  }

  hasHandler(): boolean {
    return this.handler !== null;
  }

  async publish(envelope: RawTelemetryEnvelope): Promise<TelemetryIngestResult> {
    if (!this.handler) {
      throw new Error("Handler no registrado en simulador");
    }
    return this.handler(envelope);
  }
}

describe("TelemetryService & Partition Maintenance (Issue #12)", () => {
  let ingestPort: TelemetryIngestChannel;
  let repository: InMemoryTelemetryRepository;
  let eventDispatcher: InMemoryEventDispatcher;
  let validator: TelemetryPacketValidator;
  let service: TelemetryService;

  const createConfig = (values: Record<string, unknown>) =>
    ({
      get: <T>(key: string, defaultValue?: T) =>
        (values[key] as T | undefined) ?? defaultValue,
    }) as unknown as ConfigService;

  beforeEach(() => {
    ingestPort = new TelemetryIngestChannel();
    repository = new InMemoryTelemetryRepository();
    eventDispatcher = new InMemoryEventDispatcher();
    validator = new TelemetryPacketValidator();
    service = new TelemetryService(
      ingestPort,
      repository,
      eventDispatcher,
      validator,
      createConfig({
        TELEMETRY_BATCH_SIZE: 50,
        TELEMETRY_BATCH_FLUSH_MS: 20,
      }),
    );
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it("criterio de aceptación: valida paquete JSON de WKK123, lo almacena en la partición del mes en curso y despacha evento en < 500 ms", async () => {
    const receivedEvents: TelemetryRecordedEventPayload[] = [];
    eventDispatcher.subscribe<TelemetryRecordedEventPayload>(
      TELEMETRY_GPS_RECORDED_EVENT,
      async (payload) => {
        receivedEvents.push(payload);
      },
    );

    const now = new Date();
    const expectedPartition = formatGpsPartitionName(now);

    const result = await ingestPort.publish({
      source: "MQTT",
      topic: "telemetry/vehicles/WKK123/gps",
      vehicleIdentifier: "WKK123",
      receivedAtMs: Date.now(),
      payload: Buffer.from(
        JSON.stringify({
          latitud: 4.8133,
          longitud: -75.6961,
          velocidad_kmh: 41.5,
          precision_metros: 8.5,
          rumbo_grados: 120,
          odometro_km: 15200.4,
          timestamp: now.toISOString(),
        }),
        "utf8",
      ),
    });

    expect(result.status).toBe("STORED");
    expect(result.stored).toBe(true);
    expect(result.dispatched).toBe(true);
    expect(result.placa).toBe("WKK123");
    expect(result.partition_name).toBe(expectedPartition);
    expect(result.latency_ms).toBeLessThan(500);

    expect(repository.getPartitionCount(expectedPartition)).toBe(1);
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].placa).toBe("WKK123");
    expect(receivedEvents[0].partition_name).toBe(expectedPartition);
    expect(receivedEvents[0].latency_ms).toBeLessThan(500);
  });

  it("descarta lecturas con baja precisión GPS (> 30 m) sin persistir ni despachar evento", async () => {
    const result = await ingestPort.publish({
      source: "MQTT",
      topic: "telemetry/vehicles/WKK123/gps",
      vehicleIdentifier: "WKK123",
      receivedAtMs: Date.now(),
      payload: JSON.stringify({
        latitud: 4.8133,
        longitud: -75.6961,
        velocidad_kmh: 30,
        precision_metros: 42.5,
        rumbo_grados: 90,
        odometro_km: 1000,
        timestamp: new Date().toISOString(),
      }),
    });

    expect(result.status).toBe("DISCARDED_LOW_ACCURACY");
    expect(result.stored).toBe(false);
    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe("LOW_GPS_ACCURACY");
    expect(repository.getTotalRecordCount()).toBe(0);
    expect(eventDispatcher.getTotalPublished()).toBe(0);
    expect(service.getMetrics().discardedLowAccuracy).toBe(1);
  });

  it("deduplica paquetes repetidos (mismo vehículo y timestamp) tanto en el mismo lote como en lotes consecutivos", async () => {
    const ts = new Date().toISOString();
    const makeEnvelope = (): RawTelemetryEnvelope => ({
      source: "MQTT",
      topic: "telemetry/vehicles/WKK123/gps",
      vehicleIdentifier: "WKK123",
      receivedAtMs: Date.now(),
      payload: {
        latitud: 4.8133,
        longitud: -75.6961,
        velocidad_kmh: 35,
        precision_metros: 6,
        rumbo_grados: 90,
        odometro_km: 15201,
        timestamp: ts,
      },
    });

    const [first, secondSameBatch] = await Promise.all([
      ingestPort.publish(makeEnvelope()),
      ingestPort.publish(makeEnvelope()),
    ]);

    const thirdNextBatch = await ingestPort.publish(makeEnvelope());

    expect(first.status).toBe("STORED");
    expect(secondSameBatch.status).toBe("DUPLICATE_IGNORED");
    expect(secondSameBatch.dispatched).toBe(false);
    expect(thirdNextBatch.status).toBe("DUPLICATE_IGNORED");
    expect(repository.getTotalRecordCount()).toBe(1);
    expect(eventDispatcher.getTotalPublished()).toBe(1);
  });

  it("rechaza mensajes malformados y vehículos desconocidos sin afectar el procesamiento posterior", async () => {
    const malformed = await ingestPort.publish({
      source: "MQTT",
      topic: "telemetry/vehicles/WKK123/gps",
      receivedAtMs: Date.now(),
      payload: Buffer.from("{{{malformed", "utf8"),
    });
    expect(malformed.status).toBe("REJECTED");
    expect(malformed.reason).toBe("MALFORMED_JSON");

    const unknownVehicle = await ingestPort.publish({
      source: "MQTT",
      topic: "telemetry/vehicles/ZZZ999/gps",
      receivedAtMs: Date.now(),
      payload: {
        latitud: 4.81,
        longitud: -75.69,
        velocidad_kmh: 20,
        precision_metros: 7,
        rumbo_grados: 10,
        odometro_km: 100,
        timestamp: new Date().toISOString(),
      },
    });
    expect(unknownVehicle.status).toBe("REJECTED");
    expect(unknownVehicle.reason).toBe("UNKNOWN_VEHICLE");

    const validAfterErrors = await ingestPort.publish({
      source: "MQTT",
      topic: "telemetry/vehicles/WKK123/gps",
      receivedAtMs: Date.now(),
      payload: {
        latitud: 4.8133,
        longitud: -75.6961,
        velocidad_kmh: 25,
        precision_metros: 5,
        rumbo_grados: 80,
        odometro_km: 15202,
        timestamp: new Date().toISOString(),
      },
    });
    expect(validAfterErrors.status).toBe("STORED");
  });

  it("cumple DIP: permite inyectar un adaptador simulador de ITelemetryIngestPort sin modificar TelemetryService", async () => {
    const simulatorPort = new SimulatorTelemetryIngestAdapter();
    const simService = new TelemetryService(
      simulatorPort,
      repository,
      eventDispatcher,
      validator,
      createConfig({ TELEMETRY_BATCH_SIZE: 10, TELEMETRY_BATCH_FLUSH_MS: 10 }),
    );

    try {
      const result = await simulatorPort.publish({
        source: "SIMULATOR",
        vehicleIdentifier: "WKK123",
        receivedAtMs: Date.now(),
        payload: {
          placa: "WKK123",
          latitud: 4.815,
          longitud: -75.695,
          velocidad_kmh: 32,
          precision_metros: 4.5,
          rumbo_grados: 210,
          odometro_km: 15210,
          timestamp: new Date().toISOString(),
        },
      });

      expect(result.status).toBe("STORED");
      expect(result.dispatched).toBe(true);
    } finally {
      await simService.onModuleDestroy();
    }
  });

  it("aísla errores en suscriptores del bus de eventos sin perder la persistencia", async () => {
    eventDispatcher.subscribe(TELEMETRY_GPS_RECORDED_EVENT, async () => {
      throw new Error("Fallo simulado en consumidor downstream");
    });

    const result = await ingestPort.publish({
      source: "HTTP_FALLBACK",
      vehicleIdentifier: "WKK123",
      receivedAtMs: Date.now(),
      payload: {
        placa: "WKK123",
        latitud: 4.8133,
        longitud: -75.6961,
        velocidad_kmh: 30,
        precision_metros: 10,
        rumbo_grados: 90,
        odometro_km: 15205,
        timestamp: new Date().toISOString(),
      },
    });

    expect(result.status).toBe("STORED");
    expect(repository.getTotalRecordCount()).toBe(1);
  });

  it("job de mantenimiento de particiones crea meses futuros y purga particiones mayores a 180 días", async () => {
    const job = new TelemetryPartitionMaintenanceJob(
      repository,
      createConfig({
        TELEMETRY_PARTITION_MONTHS_AHEAD: 2,
        TELEMETRY_RETENTION_DAYS: 180,
      }),
    );

    // Crear partición vencida de hace más de 180 días (enero 2026)
    await repository.ensureMonthlyPartitions(
      new Date("2026-01-15T12:00:00.000Z"),
      0,
    );
    expect(repository.getPartitionNames()).toContain("registro_gps_2026_01");

    const referenceDate = new Date("2026-11-27T12:00:00.000Z");
    const summary = await job.runMaintenance(referenceDate);

    expect(summary.created_or_verified.map((p) => p.nombre_particion)).toEqual([
      "registro_gps_2026_11",
      "registro_gps_2026_12",
      "registro_gps_2027_01",
    ]);
    expect(summary.purged.map((p) => p.nombre_particion)).toContain(
      "registro_gps_2026_01",
    );
    expect(repository.getPartitionNames()).not.toContain("registro_gps_2026_01");
    expect(repository.getPartitionNames()).toContain("registro_gps_2026_11");
    expect(job.getLastSummary()).not.toBeNull();
  });

  it("prueba de carga (DoD): ingiere 1,000 puntos (10 vehículos cada 3 s por 5 min) sin pérdida de paquetes y latencia < 500 ms", async () => {
    // Registrar 10 vehículos con sus viajes activos
    for (let v = 1; v <= 10; v += 1) {
      const suffix = String(v).padStart(3, "0");
      repository.seedVehicleContext({
        id_vehiculo: `018e38d9-3f00-7200-a100-000000000${suffix}`,
        placa: `BUS${suffix}`,
        id_viaje: `018e38d9-3f00-7200-a200-000000000${suffix}`,
      });
    }

    let dispatchedEvents = 0;
    eventDispatcher.subscribe(TELEMETRY_GPS_RECORDED_EVENT, async () => {
      dispatchedEvents += 1;
    });

    // 10 vehículos × 100 muestras (cada 3 segundos durante 5 minutos = 300 s) = 1,000 puntos
    const baseTimeMs = Date.now() - 300_000;
    const expectedPartition = formatGpsPartitionName(new Date(baseTimeMs));
    await repository.ensureMonthlyPartitions(new Date(baseTimeMs), 1);

    const startWallMs = Date.now();
    const promises: Promise<TelemetryIngestResult>[] = [];

    for (let sample = 0; sample < 100; sample += 1) {
      const sampleTimeIso = new Date(baseTimeMs + sample * 3_000).toISOString();
      for (let v = 1; v <= 10; v += 1) {
        const placa = `BUS${String(v).padStart(3, "0")}`;
        promises.push(
          ingestPort.publish({
            source: "MQTT",
            topic: `telemetry/vehicles/${placa}/gps`,
            vehicleIdentifier: placa,
            receivedAtMs: Date.now(),
            payload: Buffer.from(
              JSON.stringify({
                latitud: 4.8133 + sample * 0.0001,
                longitud: -75.6961 - v * 0.0002,
                velocidad_kmh: 35 + (sample % 15),
                precision_metros: 5 + (sample % 10),
                rumbo_grados: (sample * 17) % 360,
                odometro_km: 10000 + sample * 0.05,
                timestamp: sampleTimeIso,
              }),
              "utf8",
            ),
          }),
        );
      }
    }

    const results = await Promise.all(promises);
    const totalElapsedMs = Date.now() - startWallMs;

    expect(results).toHaveLength(1000);
    expect(results.every((r) => r.status === "STORED")).toBe(true);
    expect(results.every((r) => r.latency_ms < 500)).toBe(true);
    expect(repository.getTotalRecordCount()).toBe(1000);
    expect(repository.getPartitionCount(expectedPartition)).toBeGreaterThan(0);
    expect(dispatchedEvents).toBe(1000);
    expect(totalElapsedMs).toBeLessThan(2000);
    expect(service.getMetrics().batchesFlushed).toBeGreaterThanOrEqual(20);
  });
});
