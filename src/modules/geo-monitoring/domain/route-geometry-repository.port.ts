import { GeographicCoordinates } from "../../routes/domain/geo.types";
import {
  RecordedGeoIncident,
  RecordGeoIncidentInput,
  RouteDistanceMeasurement,
  TripRouteGeometry,
} from "./geo-monitoring.types";

export const ROUTE_GEOMETRY_REPOSITORY = Symbol("ROUTE_GEOMETRY_REPOSITORY");

/**
 * Puerto de persistencia espacial del motor de desvíos (DIP — Issue #13).
 * El adaptador PostGIS usa `ST_Simplify`, `ST_DWithin` y `ST_Distance` sobre `geography`.
 */
export interface IRouteGeometryRepository {
  /** Polilínea simplificada de la ruta del viaje y geocercas de sus paradas; `null` si el viaje no existe. */
  loadTripRouteGeometry(idViaje: string): Promise<TripRouteGeometry | null>;

  /** Confirmación exacta contra la polilínea oficial completa (`ST_DWithin` + `ST_Distance`). */
  measureDistanceToRoute(
    idRuta: string,
    punto: GeographicCoordinates,
    umbralMetros: number,
  ): Promise<RouteDistanceMeasurement | null>;

  /** Inserta el incidente de seguridad en `incidente`. */
  recordIncident(input: RecordGeoIncidentInput): Promise<RecordedGeoIncident>;
}
