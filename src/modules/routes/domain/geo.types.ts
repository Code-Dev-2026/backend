export type GeoJsonPosition = [number, number];

export interface GeoJsonPoint {
  type: "Point";
  coordinates: GeoJsonPosition;
}

export interface GeoJsonLineString {
  type: "LineString";
  coordinates: GeoJsonPosition[];
}

export interface GeoJsonPolygon {
  type: "Polygon";
  coordinates: GeoJsonPosition[][];
}

export interface GeographicCoordinates {
  latitud: number;
  longitud: number;
}

export const WGS84_SRID = 4326 as const;
export const EARTH_RADIUS_METERS = 6_371_008.8;

export const SAN_BENITO_GEOFENCE_CODE = "GEOCERCA-SAN-BENITO-OTUN" as const;
export const SAN_BENITO_SCHOOL_ID =
  "018e38d9-3f00-7200-a000-000000000002" as const;

export const SAN_BENITO_CENTER: GeographicCoordinates = {
  latitud: 4.8143,
  longitud: -75.6946,
};

export const SAN_BENITO_POLYGON: GeoJsonPolygon = {
  type: "Polygon",
  coordinates: [
    [
      [-75.69595, 4.81295],
      [-75.69325, 4.81295],
      [-75.69325, 4.81565],
      [-75.69595, 4.81565],
      [-75.69595, 4.81295],
    ],
  ],
};

/** OWASP ASVS V5.1: validación estricta de rango latitudinal [-90, 90]. */
export function isValidLatitude(lat: unknown): lat is number {
  return (
    typeof lat === "number" && Number.isFinite(lat) && lat >= -90 && lat <= 90
  );
}

/** OWASP ASVS V5.1: validación estricta de rango longitudinal [-180, 180]. */
export function isValidLongitude(lng: unknown): lng is number {
  return (
    typeof lng === "number" && Number.isFinite(lng) && lng >= -180 && lng <= 180
  );
}

/** Valida una posición GeoJSON [longitud, latitud] en WGS84 (SRID 4326). */
export function isValidGeoJsonPosition(pos: unknown): pos is GeoJsonPosition {
  if (!Array.isArray(pos) || pos.length !== 2) {
    return false;
  }
  const [lng, lat] = pos;
  return isValidLongitude(lng) && isValidLatitude(lat);
}

export function isValidGeoJsonPoint(value: unknown): value is GeoJsonPoint {
  if (!value || typeof value !== "object") {
    return false;
  }
  const point = value as Partial<GeoJsonPoint>;
  return point.type === "Point" && isValidGeoJsonPosition(point.coordinates);
}

export function isValidGeoJsonLineString(
  value: unknown,
): value is GeoJsonLineString {
  if (!value || typeof value !== "object") {
    return false;
  }
  const line = value as Partial<GeoJsonLineString>;
  return (
    line.type === "LineString" &&
    Array.isArray(line.coordinates) &&
    line.coordinates.length >= 2 &&
    line.coordinates.every(isValidGeoJsonPosition)
  );
}

export function isValidGeoJsonPolygon(value: unknown): value is GeoJsonPolygon {
  if (!value || typeof value !== "object") {
    return false;
  }
  const polygon = value as Partial<GeoJsonPolygon>;
  if (
    polygon.type !== "Polygon" ||
    !Array.isArray(polygon.coordinates) ||
    polygon.coordinates.length < 1
  ) {
    return false;
  }

  for (const ring of polygon.coordinates) {
    if (!Array.isArray(ring) || ring.length < 4) {
      return false;
    }
    if (!ring.every(isValidGeoJsonPosition)) {
      return false;
    }
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      return false;
    }
    // Al menos 3 vértices distintos para formar un área no degenerada
    const distinct = new Set(ring.slice(0, -1).map(([x, y]) => `${x}:${y}`));
    if (distinct.size < 3) {
      return false;
    }
  }
  return true;
}

/**
 * Distancia geodésica aproximada en metros (fórmula de Haversine sobre esfera WGS84 media).
 * Usada por el adaptador en memoria; el adaptador PostGIS usa ST_Distance nativo sobre esferoide.
 */
export function calculateHaversineDistanceMeters(
  origin: GeographicCoordinates,
  target: GeographicCoordinates,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(target.latitud - origin.latitud);
  const dLng = toRad(target.longitud - origin.longitud);
  const lat1 = toRad(origin.latitud);
  const lat2 = toRad(target.latitud);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Number((EARTH_RADIUS_METERS * c).toFixed(2));
}

/**
 * Genera un polígono GeoJSON cerrado aproximando una geocerca circular de `radiusMeters`
 * alrededor de un punto WGS84 (orden antihorario según RFC 7946).
 */
export function createCircularGeofencePolygon(
  latitud: number,
  longitud: number,
  radiusMeters: number,
  segments = 24,
): GeoJsonPolygon {
  const latRad = (latitud * Math.PI) / 180;
  const degLat = radiusMeters / 111_320;
  const cosLat = Math.max(Math.cos(latRad), 1e-6);
  const degLng = radiusMeters / (111_320 * cosLat);

  const ring: GeoJsonPosition[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = (2 * Math.PI * i) / segments;
    const lng = Math.max(
      -180,
      Math.min(180, Number((longitud + degLng * Math.cos(angle)).toFixed(6))),
    );
    const lat = Math.max(
      -90,
      Math.min(90, Number((latitud + degLat * Math.sin(angle)).toFixed(6))),
    );
    ring.push([lng, lat]);
  }
  ring.push([ring[0][0], ring[0][1]]);

  return {
    type: "Polygon",
    coordinates: [ring],
  };
}

/** Verifica si un punto está en el segmento [a, b] con tolerancia numérica. */
function isPointOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  const eps = 1e-9;
  const cross = (py - ay) * (bx - ax) - (px - ax) * (by - ay);
  if (Math.abs(cross) > eps) {
    return false;
  }
  const minX = Math.min(ax, bx) - eps;
  const maxX = Math.max(ax, bx) + eps;
  const minY = Math.min(ay, by) - eps;
  const maxY = Math.max(ay, by) + eps;
  return px >= minX && px <= maxX && py >= minY && py <= maxY;
}

/** Ray-casting sobre anillo cerrado (incluye borde) para paridad con ST_Covers / ST_Contains. */
function isPointInRing(
  px: number,
  py: number,
  ring: GeoJsonPosition[],
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (isPointOnSegment(px, py, xi, yi, xj, yj)) {
      return true;
    }
    const intersects =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

/** Verifica si un punto WGS84 está contenido dentro de un polígono GeoJSON (con soporte a huecos). */
export function isPointInGeoJsonPolygon(
  latitud: number,
  longitud: number,
  polygon: GeoJsonPolygon,
): boolean {
  if (polygon.coordinates.length === 0) {
    return false;
  }
  const [outer, ...holes] = polygon.coordinates;
  if (!isPointInRing(longitud, latitud, outer)) {
    return false;
  }
  return !holes.some((hole) => isPointInRing(longitud, latitud, hole));
}
