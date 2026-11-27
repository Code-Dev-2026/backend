import {
  EARTH_RADIUS_METERS,
  GeoJsonPosition,
  GeographicCoordinates,
  isPointInGeoJsonPolygon,
  isValidGeoJsonPosition,
} from "../../routes/domain/geo.types";
import { StopGeofence } from "./geo-monitoring.types";

const METERS_PER_RADIAN = EARTH_RADIUS_METERS;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Distancia perpendicular mínima (metros) de un punto WGS84 a una polilínea GeoJSON.
 *
 * Proyecta los vértices a un plano equirectangular local centrado en el punto y calcula
 * la distancia euclídea al segmento más cercano. Para distancias del orden de cientos de
 * metros el error frente a `ST_Distance` geodésico es despreciable; se usa como ruta
 * rápida en memoria por cada coordenada. Toda alerta crítica se confirma después con
 * `ST_DWithin`/`ST_Distance` en PostGIS (o el adaptador en memoria).
 *
 * Devuelve `Infinity` si la polilínea no tiene vértices válidos.
 */
export function distancePointToPolylineMeters(
  punto: GeographicCoordinates,
  polilinea: readonly GeoJsonPosition[],
): number {
  const valid = polilinea.filter(isValidGeoJsonPosition);
  if (valid.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  const cosLat = Math.cos(punto.latitud * DEG_TO_RAD);
  const project = ([lng, lat]: GeoJsonPosition): [number, number] => [
    (lng - punto.longitud) * DEG_TO_RAD * cosLat * METERS_PER_RADIAN,
    (lat - punto.latitud) * DEG_TO_RAD * METERS_PER_RADIAN,
  ];

  if (valid.length === 1) {
    const [x, y] = project(valid[0]);
    return Math.hypot(x, y);
  }

  let min = Number.POSITIVE_INFINITY;
  let [ax, ay] = project(valid[0]);
  for (let i = 1; i < valid.length; i++) {
    const [bx, by] = project(valid[i]);
    min = Math.min(min, distanceOriginToSegment(ax, ay, bx, by));
    ax = bx;
    ay = by;
  }
  return min;
}

function distanceOriginToSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return Math.hypot(ax, ay);
  }
  // Proyección del origen (el punto evaluado) sobre el segmento AB, acotada a [0, 1].
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Devuelve la parada cuya geocerca contiene el punto, o `null` si está fuera de todas. */
export function findContainingStop(
  punto: GeographicCoordinates,
  paradas: readonly StopGeofence[],
): StopGeofence | null {
  for (const parada of paradas) {
    if (
      isPointInGeoJsonPolygon(punto.latitud, punto.longitud, parada.geocerca)
    ) {
      return parada;
    }
  }
  return null;
}
