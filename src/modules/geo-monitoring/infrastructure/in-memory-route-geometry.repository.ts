import { Injectable } from "@nestjs/common";
import { uuidv7 } from "@common/utils/uuidv7";
import {
  createCircularGeofencePolygon,
  GeoJsonPosition,
  GeographicCoordinates,
  SAN_BENITO_CENTER,
} from "../../routes/domain/geo.types";
import {
  RecordedGeoIncident,
  RecordGeoIncidentInput,
  RouteDistanceMeasurement,
  StopGeofence,
  TripRouteGeometry,
} from "../domain/geo-monitoring.types";
import { distancePointToPolylineMeters } from "../domain/polyline-distance";
import { IRouteGeometryRepository } from "../domain/route-geometry-repository.port";

export interface InMemoryTripRouteSeed {
  readonly id_viaje: string;
  readonly id_ruta: string;
  readonly codigo_ruta: string;
  readonly polilinea_oficial: readonly GeoJsonPosition[];
  readonly paradas?: readonly StopGeofence[];
}

export interface StoredGeoIncident extends RecordGeoIncidentInput {
  readonly id_incidente: string;
  readonly fecha_hora: Date;
}

/** Viaje por defecto del vehículo `WKK123` sembrado en `InMemoryTelemetryRepository` (Issue #12). */
export const DEFAULT_IN_MEMORY_TRIP_ID = "018e38d9-3f00-7200-a000-000000000301";

/**
 * Adaptador en memoria del puerto espacial (modo por defecto, `GEO_USE_POSTGIS != true`).
 * Usa la polilínea completa como "simplificada" y calcula distancias con la proyección
 * local de `distancePointToPolylineMeters`.
 */
@Injectable()
export class InMemoryRouteGeometryRepository implements IRouteGeometryRepository {
  private readonly trips = new Map<string, InMemoryTripRouteSeed>();
  private readonly incidents: StoredGeoIncident[] = [];

  constructor(seedDefaults = true) {
    if (seedDefaults) {
      this.seedTrip({
        id_viaje: DEFAULT_IN_MEMORY_TRIP_ID,
        id_ruta: "018e38d9-3f00-7200-a000-000000000201",
        codigo_ruta: "R-01",
        polilinea_oficial: [
          [-75.7, 4.81],
          [-75.6961, 4.8133],
          [SAN_BENITO_CENTER.longitud, SAN_BENITO_CENTER.latitud],
        ],
        paradas: [
          {
            id_parada: "018e38d9-3f00-7200-a000-000000000401",
            nombre: "Colegio San Benito",
            geocerca: createCircularGeofencePolygon(
              SAN_BENITO_CENTER.latitud,
              SAN_BENITO_CENTER.longitud,
              50,
            ),
          },
        ],
      });
    }
  }

  seedTrip(seed: InMemoryTripRouteSeed): void {
    this.trips.set(seed.id_viaje, seed);
  }

  removeTrip(idViaje: string): void {
    this.trips.delete(idViaje);
  }

  listIncidents(): StoredGeoIncident[] {
    return this.incidents.slice();
  }

  async loadTripRouteGeometry(
    idViaje: string,
  ): Promise<TripRouteGeometry | null> {
    const seed = this.trips.get(idViaje);
    if (!seed) {
      return null;
    }
    return {
      id_viaje: seed.id_viaje,
      id_ruta: seed.id_ruta,
      codigo_ruta: seed.codigo_ruta,
      polilinea_simplificada: seed.polilinea_oficial,
      paradas: seed.paradas ?? [],
    };
  }

  async measureDistanceToRoute(
    idRuta: string,
    punto: GeographicCoordinates,
    umbralMetros: number,
  ): Promise<RouteDistanceMeasurement | null> {
    const seed = Array.from(this.trips.values()).find(
      (t) => t.id_ruta === idRuta,
    );
    if (!seed) {
      return null;
    }
    const distancia = distancePointToPolylineMeters(
      punto,
      seed.polilinea_oficial,
    );
    return {
      distancia_metros: distancia,
      dentro_umbral: distancia <= umbralMetros,
    };
  }

  async recordIncident(
    input: RecordGeoIncidentInput,
  ): Promise<RecordedGeoIncident> {
    const stored: StoredGeoIncident = {
      ...input,
      id_incidente: uuidv7(),
      fecha_hora: new Date(),
    };
    this.incidents.push(stored);
    return { id_incidente: stored.id_incidente, fecha_hora: stored.fecha_hora };
  }
}
