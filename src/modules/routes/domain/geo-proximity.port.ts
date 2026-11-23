import { GeographicCoordinates } from "./geo.types";
import { GeofenceZoneRecord, NearbyStopResult, ZoneType } from "./route.entity";

/**
 * Puerto segregado de consultas espaciales GIS (ISP - Issue #6).
 * Agrupa exclusivamente operaciones geoespaciales optimizadas sobre índices GiST
 * (ST_DWithin, ST_Distance, ST_Contains/ST_Covers) sin acoplar casos de uso logísticos.
 */
export interface IGeoProximityQueries {
  /** Busca paradas oficiales dentro de `radioMetros` usando índice GiST (ST_DWithin + ST_Distance). */
  findStopsWithinRadius(
    latitud: number,
    longitud: number,
    radioMetros: number,
    idRuta?: string,
  ): Promise<NearbyStopResult[]>;

  /** Calcula distancia geodésica exacta en metros entre dos coordenadas WGS84 (ST_Distance). */
  calculateDistanceBetweenPoints(
    origen: GeographicCoordinates,
    destino: GeographicCoordinates,
  ): Promise<number>;

  /** Calcula distancia geodésica en metros entre una coordenada WGS84 y una parada oficial. */
  calculateDistanceToStop(
    idParada: string,
    latitud: number,
    longitud: number,
  ): Promise<number | null>;

  /** Evalúa si una coordenada WGS84 está contenida en el polígono de geocerca de una parada. */
  isPointInsideStopGeofence(
    idParada: string,
    latitud: number,
    longitud: number,
  ): Promise<boolean | null>;

  /** Evalúa si una coordenada WGS84 está contenida dentro de una zona geográfica específica. */
  isPointInsideZone(
    idZona: string,
    latitud: number,
    longitud: number,
  ): Promise<boolean | null>;

  /** Retorna todas las zonas geográficas activas que contienen la coordenada WGS84 (índice GiST). */
  findContainingZones(
    latitud: number,
    longitud: number,
    tipoZona?: ZoneType,
  ): Promise<GeofenceZoneRecord[]>;

  /** Evalúa si la coordenada se encuentra dentro de la geocerca institucional del colegio. */
  isPointInsideSchoolGeofence(
    latitud: number,
    longitud: number,
    codigo?: string,
  ): Promise<{ dentro: boolean; zona: GeofenceZoneRecord | null }>;
}

export const GEO_PROXIMITY_QUERIES = Symbol("IGeoProximityQueries");
