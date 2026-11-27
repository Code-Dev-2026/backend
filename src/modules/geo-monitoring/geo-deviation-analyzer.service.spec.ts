import { AuditService } from "../audit/audit.service";
import { TELEMETRY_GPS_RECORDED_EVENT } from "../telemetry/domain/telemetry.types";
import { InMemoryEventDispatcher } from "../telemetry/infrastructure/in-memory-event-dispatcher";
import {
  COORDINATION_ROUTE_SECURITY_ALERT_EVENT,
  EVALUATION_BUDGET_MS,
  GEO_SECURITY_INCIDENT_EVENT,
  ROUTE_GEOMETRY_CACHE_TTL_MS,
} from "./domain/geo-monitoring.constants";
import {
  GeoAnomalyType,
  RouteSecurityAlertPayload,
} from "./domain/geo-monitoring.types";
import { IGeoSecurityAlertPort } from "./domain/geo-security-alert.port";
import { ITelemetryAnomalyRule } from "./domain/telemetry-anomaly-rule.interface";
import {
  GeoDeviationAnalyzer,
  GeoEvaluationResult,
  parseGpsSample,
} from "./geo-deviation-analyzer.service";
import { GeoSecurityIncidentReporter } from "./geo-security-incident-reporter.service";
import { InMemoryRouteGeometryRepository } from "./infrastructure/in-memory-route-geometry.repository";
import { ProlongedStopDetector } from "./rules/prolonged-stop.detector";
import { RouteDeviationDetector } from "./rules/route-deviation.detector";
import {
  DEVIATED_ROUTE_SEQUENCE,
  FIXTURE_TRIP_ID,
  NORMAL_ROUTE_SEQUENCE,
  PROLONGED_STOP_OUTSIDE_SEQUENCE,
  R01_SEED,
  RecordedReading,
  toSamples,
  toTelemetryEvent,
  URBAN_CANYON_DRIFT_SEQUENCE,
} from "./__fixtures__/recorded-gps-sequences";

class RecordingAlertPort implements IGeoSecurityAlertPort {
  readonly alerts: RouteSecurityAlertPayload[] = [];
  failNext = false;

  async emitRouteSecurityAlert(
    payload: RouteSecurityAlertPayload,
  ): Promise<boolean> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("Socket.IO caído");
    }
    this.alerts.push(payload);
    return true;
  }
}

/** Deja correr las promesas lanzadas sin `await` por el suscriptor. */
const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

describe("GeoDeviationAnalyzer — motor de desvíos en streaming (Issue #13)", () => {
  let nowMs: number;
  let dispatcher: InMemoryEventDispatcher;
  let repository: InMemoryRouteGeometryRepository;
  let alertPort: RecordingAlertPort;
  let audit: { logCriticalEvent: jest.Mock };
  let reporter: GeoSecurityIncidentReporter;
  let rules: ITelemetryAnomalyRule[];
  let analyzer: GeoDeviationAnalyzer;

  const build = (extraRules: ITelemetryAnomalyRule[] = []) => {
    rules = [
      new RouteDeviationDetector(repository),
      new ProlongedStopDetector(),
      ...extraRules,
    ];
    analyzer = new GeoDeviationAnalyzer(
      dispatcher,
      repository,
      rules,
      reporter,
      () => nowMs,
    );
    analyzer.onModuleInit();
  };

  const replay = async (
    readings: readonly RecordedReading[],
    idViaje = FIXTURE_TRIP_ID,
  ): Promise<GeoEvaluationResult[]> => {
    const results: GeoEvaluationResult[] = [];
    for (const sample of toSamples(readings, idViaje)) {
      results.push(
        await analyzer.processTelemetryEvent(toTelemetryEvent(sample)),
      );
    }
    return results;
  };

  beforeEach(() => {
    nowMs = Date.parse("2026-11-27T12:00:00.000Z");
    dispatcher = new InMemoryEventDispatcher();
    repository = new InMemoryRouteGeometryRepository(false);
    repository.seedTrip(R01_SEED);
    alertPort = new RecordingAlertPort();
    audit = { logCriticalEvent: jest.fn().mockResolvedValue(undefined) };
    reporter = new GeoSecurityIncidentReporter(
      repository,
      alertPort,
      audit as unknown as AuditService,
      dispatcher,
    );
    build();
  });

  afterEach(() => {
    analyzer.onModuleDestroy();
  });

  describe("Criterio de aceptación", () => {
    it("vía alterna a 350 m de R-01 → incidente DESVIO_RUTA_SIGNIFICATIVO y alerta crítica a Coordinación", async () => {
      const results = await replay(DEVIATED_ROUTE_SEQUENCE);

      const withDetection = results.filter((r) => r.detecciones.length > 0);
      expect(withDetection).toHaveLength(1);
      expect(withDetection[0].detecciones).toEqual([
        "DESVIO_RUTA_SIGNIFICATIVO",
      ]);

      const incidents = repository.listIncidents();
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        id_viaje: FIXTURE_TRIP_ID,
        tipo_incidente: "DESVIO_RUTA_SIGNIFICATIVO",
        severidad: "CRITICO",
      });
      expect(withDetection[0].incidentes).toEqual([incidents[0].id_incidente]);

      expect(alertPort.alerts).toHaveLength(1);
      expect(alertPort.alerts[0]).toMatchObject({
        evento: COORDINATION_ROUTE_SECURITY_ALERT_EVENT,
        tipo_incidente: "DESVIO_RUTA_SIGNIFICATIVO",
        severidad: "CRITICO",
        codigo_ruta: "R-01",
        id_incidente: incidents[0].id_incidente,
        placa: "WKK123",
      });
      expect(alertPort.alerts[0].metricas.distancia_metros).toBeGreaterThan(
        300,
      );
    });

    it("recorrido normal → sin incidentes ni alertas", async () => {
      const results = await replay(NORMAL_ROUTE_SEQUENCE);
      expect(results.every((r) => r.status === "EVALUATED")).toBe(true);
      expect(repository.listIncidents()).toEqual([]);
      expect(alertPort.alerts).toEqual([]);
    });

    it("deriva de cañón urbano → sin alerta crítica", async () => {
      await replay(URBAN_CANYON_DRIFT_SEQUENCE);
      expect(repository.listIncidents()).toEqual([]);
    });

    it("detención prolongada fuera de parada → incidente DETENCION_PROLONGADA", async () => {
      await replay(PROLONGED_STOP_OUTSIDE_SEQUENCE);
      expect(repository.listIncidents().map((i) => i.tipo_incidente)).toEqual([
        "DETENCION_PROLONGADA",
      ]);
      expect(alertPort.alerts.map((a) => a.tipo_incidente)).toEqual([
        "DETENCION_PROLONGADA",
      ]);
    });
  });

  describe("Integración con la telemetría (Issue #12)", () => {
    it("consume telemetry.gps.recorded sin bloquear al publicador", async () => {
      for (const sample of toSamples(DEVIATED_ROUTE_SEQUENCE)) {
        await dispatcher.publish(
          TELEMETRY_GPS_RECORDED_EVENT,
          toTelemetryEvent(sample),
        );
      }
      for (let i = 0; i < 20 && repository.listIncidents().length === 0; i++) {
        await flushAsync();
      }

      expect(repository.listIncidents()).toHaveLength(1);
      expect(analyzer.getMetrics().received).toBe(
        DEVIATED_ROUTE_SEQUENCE.length,
      );
    });

    it("publica geo.security.incident para el módulo de notificaciones (Issue #15)", async () => {
      await replay(DEVIATED_ROUTE_SEQUENCE);
      const events = dispatcher.getRecentEvents(GEO_SECURITY_INCIDENT_EVENT);
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        tipo_incidente: "DESVIO_RUTA_SIGNIFICATIVO",
      });
    });

    it("deja de consumir eventos tras onModuleDestroy", async () => {
      analyzer.onModuleDestroy();
      const [sample] = toSamples(NORMAL_ROUTE_SEQUENCE);
      await dispatcher.publish(
        TELEMETRY_GPS_RECORDED_EVENT,
        toTelemetryEvent(sample),
      );
      await flushAsync();
      expect(analyzer.getMetrics().received).toBe(0);
    });
  });

  describe("Robustez del flujo", () => {
    it.each([
      ["nulo", null],
      [
        "sin id_viaje",
        {
          ...toTelemetryEvent(toSamples(NORMAL_ROUTE_SEQUENCE)[0]),
          id_viaje: "",
        },
      ],
      [
        "latitud fuera de rango",
        {
          ...toTelemetryEvent(toSamples(NORMAL_ROUTE_SEQUENCE)[0]),
          latitud: 95,
        },
      ],
      [
        "velocidad negativa",
        {
          ...toTelemetryEvent(toSamples(NORMAL_ROUTE_SEQUENCE)[0]),
          velocidad_kmh: -1,
        },
      ],
      [
        "fecha inválida",
        {
          ...toTelemetryEvent(toSamples(NORMAL_ROUTE_SEQUENCE)[0]),
          fecha_hora: "ayer",
        },
      ],
    ])("descarta payload malformado (%s)", async (_label, payload) => {
      const result = await analyzer.processTelemetryEvent(payload);
      expect(result.status).toBe("REJECTED_MALFORMED");
      expect(analyzer.getMetrics().rejectedMalformed).toBe(1);
    });

    it("ignora lecturas duplicadas o fuera de orden", async () => {
      const [first, second] = toSamples(NORMAL_ROUTE_SEQUENCE);
      await analyzer.processTelemetryEvent(toTelemetryEvent(second));
      const duplicate = await analyzer.processTelemetryEvent(
        toTelemetryEvent(second),
      );
      const older = await analyzer.processTelemetryEvent(
        toTelemetryEvent(first),
      );

      expect(duplicate.status).toBe("IGNORED_DUPLICATE_OR_OUT_OF_ORDER");
      expect(older.status).toBe("IGNORED_DUPLICATE_OR_OUT_OF_ORDER");
    });

    it("procesa en serie las lecturas concurrentes de un mismo viaje", async () => {
      const samples = toSamples(DEVIATED_ROUTE_SEQUENCE);
      const results = await Promise.all(
        samples.map((s) => analyzer.processTelemetryEvent(toTelemetryEvent(s))),
      );
      expect(results.every((r) => r.status === "EVALUATED")).toBe(true);
      expect(repository.listIncidents()).toHaveLength(1);
    });

    it("devuelve NO_ROUTE_GEOMETRY para viajes sin ruta", async () => {
      const [result] = await replay(
        NORMAL_ROUTE_SEQUENCE.slice(0, 1),
        "018e38d9-3f00-7200-a000-00000000ffff",
      );
      expect(result.status).toBe("NO_ROUTE_GEOMETRY");
    });

    it("cachea la polilínea simplificada y la recarga al vencer el TTL", async () => {
      const loadSpy = jest.spyOn(repository, "loadTripRouteGeometry");
      const events = toSamples(NORMAL_ROUTE_SEQUENCE).map(toTelemetryEvent);
      for (const event of events.slice(0, 5)) {
        await analyzer.processTelemetryEvent(event);
      }
      expect(loadSpy).toHaveBeenCalledTimes(1);

      nowMs += ROUTE_GEOMETRY_CACHE_TTL_MS + 1;
      await analyzer.processTelemetryEvent(events[5]);
      expect(loadSpy).toHaveBeenCalledTimes(2);

      analyzer.invalidateRouteGeometry(FIXTURE_TRIP_ID);
      await analyzer.processTelemetryEvent(events[6]);
      expect(loadSpy).toHaveBeenCalledTimes(3);
    });

    it("aísla el fallo de una regla sin detener las demás", async () => {
      const failing: ITelemetryAnomalyRule = {
        code: "DETENCION_PROLONGADA",
        evaluate: jest.fn().mockRejectedValue(new Error("boom")),
        resetTrip: jest.fn(),
      };
      analyzer.onModuleDestroy();
      build([failing]);

      await replay(DEVIATED_ROUTE_SEQUENCE);
      expect(repository.listIncidents()).toHaveLength(1);
      expect(analyzer.getMetrics().ruleErrors).toBe(
        DEVIATED_ROUTE_SEQUENCE.length,
      );
    });
  });

  describe("OCP — ITelemetryAnomalyRule", () => {
    it("ejecuta una regla nueva (p. ej. SpeedingDetector) sin modificar el motor", async () => {
      const SPEEDING = "EXCESO_VELOCIDAD" as GeoAnomalyType;
      const speeding: ITelemetryAnomalyRule = {
        code: SPEEDING,
        evaluate: async ({ sample }) =>
          sample.velocidad_kmh > 60
            ? {
                tipo_incidente: SPEEDING,
                severidad: "CRITICO",
                descripcion: "Exceso de velocidad",
                coordenadas: {
                  latitud: sample.latitud,
                  longitud: sample.longitud,
                },
                fecha_hora: sample.fecha_hora,
                metricas: { velocidad_kmh: sample.velocidad_kmh },
              }
            : null,
        resetTrip: () => undefined,
      };
      analyzer.onModuleDestroy();
      build([speeding]);

      const fast = NORMAL_ROUTE_SEQUENCE.map((r, i) =>
        i === 4 ? { ...r, velocidad_kmh: 85 } : r,
      );
      await replay(fast);
      expect(repository.listIncidents().map((i) => i.tipo_incidente)).toEqual([
        SPEEDING,
      ]);
    });
  });

  describe("GeoSecurityIncidentReporter — ASVS V1.14", () => {
    it("encadena el incidente en la bitácora forense con su contexto", async () => {
      await replay(DEVIATED_ROUTE_SEQUENCE);
      const [incident] = repository.listIncidents();
      expect(audit.logCriticalEvent).toHaveBeenCalledTimes(1);
      expect(audit.logCriticalEvent).toHaveBeenCalledWith({
        tipo_evento: "DESVIO_RUTA_SIGNIFICATIVO",
        id_viaje: FIXTURE_TRIP_ID,
        payload: expect.objectContaining({
          id_incidente: incident.id_incidente,
          codigo_ruta: "R-01",
          severidad: "CRITICO",
        }),
      });
    });

    it("conserva el incidente registrado aunque fallen auditoría y Socket.IO", async () => {
      audit.logCriticalEvent.mockRejectedValueOnce(new Error("ledger"));
      alertPort.failNext = true;

      const results = await replay(DEVIATED_ROUTE_SEQUENCE);
      expect(repository.listIncidents()).toHaveLength(1);
      expect(results.flatMap((r) => r.incidentes)).toHaveLength(1);
      expect(
        dispatcher.getRecentEvents(GEO_SECURITY_INCIDENT_EVENT),
      ).toHaveLength(1);
    });

    it("contabiliza el error si no se puede persistir el incidente", async () => {
      jest
        .spyOn(repository, "recordIncident")
        .mockRejectedValueOnce(new Error("db down"));
      const results = await replay(DEVIATED_ROUTE_SEQUENCE);
      expect(results.flatMap((r) => r.incidentes)).toEqual([]);
      expect(analyzer.getMetrics().reportErrors).toBe(1);
      expect(alertPort.alerts).toEqual([]);
    });
  });

  describe("DoD — evaluación < 100 ms por coordenada", () => {
    it("mantiene el tiempo de evaluación por debajo del presupuesto en 1 000 lecturas", async () => {
      const readings: RecordedReading[] = Array.from(
        { length: 1000 },
        (_, i) => ({
          t: i,
          longitud: -75.7 + (i % 200) * 0.0001,
          offsetNorteMetros: (i * 37) % 280,
          velocidad_kmh: 30,
        }),
      );
      const results = await replay(readings);

      const metrics = analyzer.getMetrics();
      expect(metrics.evaluated).toBe(1000);
      expect(metrics.overBudgetEvaluations).toBe(0);
      expect(metrics.maxEvaluationMs).toBeLessThan(EVALUATION_BUDGET_MS);
      expect(results.every((r) => r.evaluation_ms < EVALUATION_BUDGET_MS)).toBe(
        true,
      );
    });
  });
});

describe("parseGpsSample", () => {
  it("normaliza el payload de telemetría y asigna placa por defecto", () => {
    const [sample] = toSamples(NORMAL_ROUTE_SEQUENCE);
    const parsed = parseGpsSample({
      ...toTelemetryEvent(sample),
      placa: undefined,
    });
    expect(parsed).toMatchObject({
      id_viaje: FIXTURE_TRIP_ID,
      placa: "DESCONOCIDA",
      fecha_hora: sample.fecha_hora,
    });
  });
});
