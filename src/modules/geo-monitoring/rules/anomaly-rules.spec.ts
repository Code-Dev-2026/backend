import {
  ROUTE_DEVIATION_CONFIRMATION_READINGS,
  ROUTE_DEVIATION_THRESHOLD_METERS,
} from "../domain/geo-monitoring.constants";
import {
  AnomalyDetection,
  GpsSample,
  TripRouteGeometry,
} from "../domain/geo-monitoring.types";
import {
  distancePointToPolylineMeters,
  findContainingStop,
} from "../domain/polyline-distance";
import { ITelemetryAnomalyRule } from "../domain/telemetry-anomaly-rule.interface";
import { InMemoryRouteGeometryRepository } from "../infrastructure/in-memory-route-geometry.repository";
import {
  DEVIATED_ROUTE_SEQUENCE,
  DOUBLE_DEVIATION_SEQUENCE,
  LONG_STOP_BEYOND_WINDOW_SEQUENCE,
  metersNorthToLatitude,
  NORMAL_ROUTE_SEQUENCE,
  PROLONGED_STOP_OUTSIDE_SEQUENCE,
  R01_GEOMETRY,
  R01_POLYLINE,
  R01_SEED,
  RecordedReading,
  ROUTE_END_LONGITUDE,
  ROUTE_LATITUDE,
  SHORT_STOP_SEQUENCE,
  STOP_INSIDE_GEOFENCE_SEQUENCE,
  STOP_LONGITUDE,
  toSamples,
  URBAN_CANYON_DRIFT_SEQUENCE,
} from "../__fixtures__/recorded-gps-sequences";
import { ProlongedStopDetector } from "./prolonged-stop.detector";
import { RouteDeviationDetector } from "./route-deviation.detector";

const WINDOW_SIZE = 10;

/** Reproduce una secuencia pre-grabada contra una regla con ventana deslizante de 10 lecturas. */
async function replay(
  rule: ITelemetryAnomalyRule,
  readings: readonly RecordedReading[],
  route: TripRouteGeometry = R01_GEOMETRY,
): Promise<Array<{ index: number; detection: AnomalyDetection }>> {
  const samples = toSamples(readings);
  const window: GpsSample[] = [];
  const detections: Array<{ index: number; detection: AnomalyDetection }> = [];
  for (let i = 0; i < samples.length; i++) {
    window.push(samples[i]);
    if (window.length > WINDOW_SIZE) {
      window.shift();
    }
    const detection = await rule.evaluate({
      sample: samples[i],
      window: window.slice(),
      route,
    });
    if (detection) {
      detections.push({ index: i, detection });
    }
  }
  return detections;
}

describe("distancePointToPolylineMeters (Issue #13)", () => {
  it.each([0, 150, 300, 350, 1000])(
    "mide %d m de distancia perpendicular al trazado con error < 0,5 %%",
    (offset) => {
      const distance = distancePointToPolylineMeters(
        { latitud: metersNorthToLatitude(offset), longitud: -75.6925 },
        R01_POLYLINE,
      );
      expect(Math.abs(distance - offset)).toBeLessThanOrEqual(
        Math.max(0.5, offset * 0.005),
      );
    },
  );

  it("usa la distancia al extremo cuando la proyección cae fuera del segmento", () => {
    // 0,001° de longitud ≈ 110,8 m al este del final del trazado, sobre la misma latitud.
    const distance = distancePointToPolylineMeters(
      { latitud: ROUTE_LATITUDE, longitud: ROUTE_END_LONGITUDE + 0.001 },
      R01_POLYLINE,
    );
    expect(distance).toBeGreaterThan(105);
    expect(distance).toBeLessThan(115);
  });

  it("devuelve Infinity con una polilínea sin vértices válidos", () => {
    expect(
      distancePointToPolylineMeters({ latitud: 4.81, longitud: -75.69 }, []),
    ).toBe(Number.POSITIVE_INFINITY);
  });

  it("identifica la geocerca de parada que contiene el punto", () => {
    expect(
      findContainingStop(
        { latitud: ROUTE_LATITUDE, longitud: STOP_LONGITUDE },
        R01_GEOMETRY.paradas,
      )?.nombre,
    ).toBe("Parada Intermedia R-01");
    expect(
      findContainingStop(
        { latitud: ROUTE_LATITUDE, longitud: -75.6975 },
        R01_GEOMETRY.paradas,
      ),
    ).toBeNull();
  });
});

describe("RouteDeviationDetector (Issue #13 — RF-15)", () => {
  let repository: InMemoryRouteGeometryRepository;
  let detector: RouteDeviationDetector;

  beforeEach(() => {
    repository = new InMemoryRouteGeometryRepository(false);
    repository.seedTrip(R01_SEED);
    detector = new RouteDeviationDetector(repository);
  });

  it("no alerta en un recorrido normal sobre el trazado", async () => {
    await expect(replay(detector, NORMAL_ROUTE_SEQUENCE)).resolves.toEqual([]);
  });

  it("alerta DESVIO_RUTA_SIGNIFICATIVO a 350 m tras 3 lecturas consecutivas, una sola vez por episodio", async () => {
    const detections = await replay(detector, DEVIATED_ROUTE_SEQUENCE);

    expect(detections).toHaveLength(1);
    const [{ index, detection }] = detections;
    // Lecturas 3, 4 y 5 están a 350 m: se confirma en la tercera (índice 5).
    expect(index).toBe(5);
    expect(detection.tipo_incidente).toBe("DESVIO_RUTA_SIGNIFICATIVO");
    expect(detection.severidad).toBe("CRITICO");
    expect(detection.metricas.umbral_metros).toBe(
      ROUTE_DEVIATION_THRESHOLD_METERS,
    );
    expect(detection.metricas.lecturas_consecutivas_fuera).toBe(
      ROUTE_DEVIATION_CONFIRMATION_READINGS,
    );
    expect(detection.metricas.distancia_metros).toBeGreaterThan(345);
    expect(detection.metricas.distancia_metros).toBeLessThan(355);
    expect(detection.descripcion).toContain("R-01");
    expect(detection.descripcion).toContain("WKK123");
  });

  it("filtra derivas momentáneas del GPS en cañones urbanos (< 3 lecturas consecutivas)", async () => {
    const measureSpy = jest.spyOn(repository, "measureDistanceToRoute");
    await expect(
      replay(detector, URBAN_CANYON_DRIFT_SEQUENCE),
    ).resolves.toEqual([]);
    // Sin candidatos confirmados no se consulta la geometría oficial.
    expect(measureSpy).not.toHaveBeenCalled();
  });

  it("se rearma al volver al trazado y alerta un segundo episodio", async () => {
    const detections = await replay(detector, DOUBLE_DEVIATION_SEQUENCE);
    expect(detections.map((d) => d.index)).toEqual([2, 7]);
  });

  it("no alerta exactamente en 300 m (el umbral es estrictamente mayor)", async () => {
    const atThreshold: RecordedReading[] = Array.from(
      { length: 5 },
      (_, i) => ({
        t: i * 10,
        longitud: -75.697 + i * 0.001,
        offsetNorteMetros: 299.5,
        velocidad_kmh: 30,
      }),
    );
    await expect(replay(detector, atThreshold)).resolves.toEqual([]);
  });

  it("descarta el candidato cuando la confirmación exacta (ST_DWithin) lo ubica dentro del umbral", async () => {
    // Polilínea "simplificada" que perdió un vértice desviado hacia el norte de la oficial.
    const oficialConCurva = [
      [-75.7, 4.81],
      [-75.697, metersNorthToLatitude(400)],
      [-75.694, 4.81],
      [-75.68, 4.81],
    ] as [number, number][];
    repository.seedTrip({ ...R01_SEED, polilinea_oficial: oficialConCurva });
    const simplificada: TripRouteGeometry = {
      ...R01_GEOMETRY,
      polilinea_simplificada: [
        [-75.7, 4.81],
        [-75.68, 4.81],
      ],
    };
    const curve: RecordedReading[] = Array.from({ length: 4 }, (_, i) => ({
      t: i * 10,
      longitud: -75.697,
      offsetNorteMetros: 380,
      velocidad_kmh: 30,
    }));

    await expect(replay(detector, curve, simplificada)).resolves.toEqual([]);
  });

  it("ignora viajes sin polilínea válida", async () => {
    const empty: TripRouteGeometry = {
      ...R01_GEOMETRY,
      polilinea_simplificada: [],
    };
    await expect(
      replay(detector, DEVIATED_ROUTE_SEQUENCE, empty),
    ).resolves.toEqual([]);
  });
});

describe("ProlongedStopDetector (Issue #13 — RF-15)", () => {
  let detector: ProlongedStopDetector;

  beforeEach(() => {
    detector = new ProlongedStopDetector();
  });

  it("alerta DETENCION_PROLONGADA tras > 5 min a < 3 km/h fuera de geocerca de parada", async () => {
    const detections = await replay(detector, PROLONGED_STOP_OUTSIDE_SEQUENCE);

    expect(detections).toHaveLength(1);
    const [{ index, detection }] = detections;
    // Inmóvil desde t=60 s; a t=360 s lleva 300 s (no supera); a t=420 s lleva 360 s.
    expect(index).toBe(8);
    expect(detection.tipo_incidente).toBe("DETENCION_PROLONGADA");
    expect(detection.severidad).toBe("CRITICO");
    expect(detection.metricas.duracion_segundos).toBe(360);
    expect(detection.metricas.umbral_segundos).toBe(300);
  });

  it("no alerta si el vehículo está detenido dentro de la geocerca de una parada", async () => {
    await expect(
      replay(detector, STOP_INSIDE_GEOFENCE_SEQUENCE),
    ).resolves.toEqual([]);
  });

  it("no alerta en detenciones cortas (semáforo / trancón de 4 min)", async () => {
    await expect(replay(detector, SHORT_STOP_SEQUENCE)).resolves.toEqual([]);
  });

  it("no alerta en un recorrido normal en movimiento", async () => {
    await expect(replay(detector, NORMAL_ROUTE_SEQUENCE)).resolves.toEqual([]);
  });

  it("conserva el inicio del episodio aunque la detención supere la ventana de 10 lecturas", async () => {
    const detections = await replay(detector, LONG_STOP_BEYOND_WINDOW_SEQUENCE);
    expect(detections).toHaveLength(1);
    expect(detections[0].index).toBe(11);
    expect(detections[0].detection.metricas.duracion_segundos).toBe(330);
  });

  it("toma el inicio de la racha inmóvil desde la ventana al primer evaluarla", async () => {
    // Simula un detector recién creado (p. ej. tras reinicio) con la ventana ya poblada.
    const samples = toSamples(PROLONGED_STOP_OUTSIDE_SEQUENCE);
    const last = samples[samples.length - 1];
    const detection = await detector.evaluate({
      sample: last,
      window: samples,
      route: R01_GEOMETRY,
    });
    expect(detection?.metricas.duracion_segundos).toBe(360);
  });

  it("resetTrip libera el estado del viaje", async () => {
    await replay(detector, PROLONGED_STOP_OUTSIDE_SEQUENCE);
    detector.resetTrip(R01_GEOMETRY.id_viaje);
    // Tras el reset una nueva detención vuelve a medirse desde cero.
    await expect(replay(detector, SHORT_STOP_SEQUENCE)).resolves.toEqual([]);
  });
});
