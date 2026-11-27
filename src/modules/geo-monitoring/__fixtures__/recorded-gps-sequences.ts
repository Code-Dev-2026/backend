import {
  createCircularGeofencePolygon,
  EARTH_RADIUS_METERS,
  GeoJsonPosition,
} from "../../routes/domain/geo.types";
import { GpsSample, TripRouteGeometry } from "../domain/geo-monitoring.types";
import { InMemoryTripRouteSeed } from "../infrastructure/in-memory-route-geometry.repository";

/**
 * Secuencias de coordenadas GPS pre-grabadas para las pruebas del Issue #13.
 *
 * Ruta `R-01` de prueba: trazado recto oeste→este sobre la latitud 4.81 (≈ 2,2 km).
 * Los desplazamientos se expresan en metros al norte del trazado, de modo que la
 * distancia perpendicular esperada es exactamente `offsetNorteMetros`.
 */
export const FIXTURE_TRIP_ID = "018e38d9-3f00-7200-a000-00000000a301";
export const FIXTURE_ROUTE_ID = "018e38d9-3f00-7200-a000-00000000a201";
export const FIXTURE_VEHICLE_ID = "018e38d9-3f00-7200-a000-00000000a101";
export const FIXTURE_PLATE = "WKK123";

export const ROUTE_LATITUDE = 4.81;
export const ROUTE_START_LONGITUDE = -75.7;
export const ROUTE_END_LONGITUDE = -75.68;

/** Parada intermedia con geocerca circular de 50 m sobre el trazado. */
export const STOP_LONGITUDE = -75.69;
export const STOP_RADIUS_METERS = 50;

export const R01_POLYLINE: GeoJsonPosition[] = [
  [ROUTE_START_LONGITUDE, ROUTE_LATITUDE],
  [-75.695, ROUTE_LATITUDE],
  [STOP_LONGITUDE, ROUTE_LATITUDE],
  [-75.685, ROUTE_LATITUDE],
  [ROUTE_END_LONGITUDE, ROUTE_LATITUDE],
];

export const R01_STOP = {
  id_parada: "018e38d9-3f00-7200-a000-00000000a401",
  nombre: "Parada Intermedia R-01",
  geocerca: createCircularGeofencePolygon(
    ROUTE_LATITUDE,
    STOP_LONGITUDE,
    STOP_RADIUS_METERS,
  ),
};

export const R01_SEED: InMemoryTripRouteSeed = {
  id_viaje: FIXTURE_TRIP_ID,
  id_ruta: FIXTURE_ROUTE_ID,
  codigo_ruta: "R-01",
  polilinea_oficial: R01_POLYLINE,
  paradas: [R01_STOP],
};

export const R01_GEOMETRY: TripRouteGeometry = {
  id_viaje: FIXTURE_TRIP_ID,
  id_ruta: FIXTURE_ROUTE_ID,
  codigo_ruta: "R-01",
  polilinea_simplificada: R01_POLYLINE,
  paradas: [R01_STOP],
};

export const T0 = new Date("2026-11-27T12:00:00.000Z");

const METERS_PER_DEGREE_LAT = (EARTH_RADIUS_METERS * Math.PI) / 180;

export function metersNorthToLatitude(offsetNorteMetros: number): number {
  return ROUTE_LATITUDE + offsetNorteMetros / METERS_PER_DEGREE_LAT;
}

export interface RecordedReading {
  /** Segundos desde `T0`. */
  readonly t: number;
  readonly longitud: number;
  readonly offsetNorteMetros: number;
  readonly velocidad_kmh: number;
}

export function toSamples(
  readings: readonly RecordedReading[],
  idViaje = FIXTURE_TRIP_ID,
): GpsSample[] {
  return readings.map((r, i) => ({
    id_gps: `${idViaje}-gps-${String(i).padStart(4, "0")}`,
    id_viaje: idViaje,
    id_vehiculo: FIXTURE_VEHICLE_ID,
    placa: FIXTURE_PLATE,
    latitud: metersNorthToLatitude(r.offsetNorteMetros),
    longitud: r.longitud,
    velocidad_kmh: r.velocidad_kmh,
    fecha_hora: new Date(T0.getTime() + r.t * 1000),
  }));
}

/** Payload equivalente a `telemetry.gps.recorded` (Issue #12). */
export function toTelemetryEvent(sample: GpsSample): Record<string, unknown> {
  return {
    id_gps: sample.id_gps,
    id_viaje: sample.id_viaje,
    id_vehiculo: sample.id_vehiculo,
    placa: sample.placa,
    latitud: sample.latitud,
    longitud: sample.longitud,
    velocidad_kmh: sample.velocidad_kmh,
    rumbo_grados: 90,
    precision_metros: 4,
    fecha_hora: sample.fecha_hora.toISOString(),
    source: "MQTT",
  };
}

const moving = (
  t: number,
  longitud: number,
  offsetNorteMetros = 0,
  velocidad_kmh = 32,
): RecordedReading => ({ t, longitud, offsetNorteMetros, velocidad_kmh });

/** Recorrido normal: sigue el trazado con deriva GPS de ±25 m. */
export const NORMAL_ROUTE_SEQUENCE: RecordedReading[] = [
  moving(0, -75.6995, 5),
  moving(10, -75.699, -12),
  moving(20, -75.698, 20),
  moving(30, -75.697, -25),
  moving(40, -75.696, 8),
  moving(50, -75.695, 15),
  moving(60, -75.694, -18),
  moving(70, -75.693, 25),
  moving(80, -75.692, -3),
  moving(90, -75.691, 10),
];

/** Criterio de aceptación: vía alterna a 350 m de la polilínea oficial de `R-01`. */
export const DEVIATED_ROUTE_SEQUENCE: RecordedReading[] = [
  moving(0, -75.6995, 0),
  moving(10, -75.699, 10),
  moving(20, -75.698, 120),
  moving(30, -75.697, 350),
  moving(40, -75.696, 350),
  moving(50, -75.695, 350),
  moving(60, -75.694, 350),
  moving(70, -75.693, 350),
];

/** Cañón urbano: saltos aislados (1–2 lecturas) a > 300 m que no deben alertar. */
export const URBAN_CANYON_DRIFT_SEQUENCE: RecordedReading[] = [
  moving(0, -75.6995, 0),
  moving(10, -75.699, 420),
  moving(20, -75.698, 10),
  moving(30, -75.697, 380),
  moving(40, -75.696, 390),
  moving(50, -75.695, -5),
  moving(60, -75.694, 360),
  moving(70, -75.693, 12),
];

/** Desvío, regreso al trazado y segundo desvío: dos episodios, dos alertas. */
export const DOUBLE_DEVIATION_SEQUENCE: RecordedReading[] = [
  moving(0, -75.6995, 350),
  moving(10, -75.699, 350),
  moving(20, -75.698, 350),
  moving(30, -75.697, 350),
  moving(40, -75.696, 0),
  moving(50, -75.695, 400),
  moving(60, -75.694, 400),
  moving(70, -75.693, 400),
];

const stopped = (
  t: number,
  longitud: number,
  velocidad_kmh = 0.5,
): RecordedReading => ({ t, longitud, offsetNorteMetros: 4, velocidad_kmh });

/** Detenido fuera de parada (sobre el trazado) durante 6 minutos, lecturas cada 60 s. */
export const PROLONGED_STOP_OUTSIDE_SEQUENCE: RecordedReading[] = [
  moving(0, -75.6985),
  moving(30, -75.698),
  stopped(60, -75.6975, 0),
  stopped(120, -75.6975, 1.2),
  stopped(180, -75.6975, 0),
  stopped(240, -75.6975, 2.9),
  stopped(300, -75.6975, 0),
  stopped(360, -75.6975, 0.4),
  stopped(420, -75.6975, 0),
];

/** Misma detención pero dentro de la geocerca de la parada: no es anomalía. */
export const STOP_INSIDE_GEOFENCE_SEQUENCE: RecordedReading[] =
  PROLONGED_STOP_OUTSIDE_SEQUENCE.map((r) =>
    r.velocidad_kmh < 3 ? { ...r, longitud: STOP_LONGITUDE } : r,
  );

/** Semáforo / trancón corto: 4 minutos detenido y luego reanuda la marcha. */
export const SHORT_STOP_SEQUENCE: RecordedReading[] = [
  moving(0, -75.6985),
  stopped(30, -75.698),
  stopped(90, -75.698),
  stopped(150, -75.698),
  stopped(210, -75.698),
  stopped(270, -75.698),
  moving(300, -75.6975),
  moving(310, -75.697),
];

/**
 * Detención de 12 lecturas cada 30 s (> tamaño de ventana de 10): el inicio del
 * episodio debe conservarse aunque la primera lectura inmóvil salga de la ventana.
 */
export const LONG_STOP_BEYOND_WINDOW_SEQUENCE: RecordedReading[] = Array.from(
  { length: 13 },
  (_, k) => stopped(k * 30, -75.6975),
);
