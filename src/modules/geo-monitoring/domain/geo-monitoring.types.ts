import {
  GeoJsonPolygon,
  GeoJsonPosition,
  GeographicCoordinates,
} from "../../routes/domain/geo.types";

/** Tipos de incidente generados por el motor (coinciden con `tipo_notificacion.codigo` sembrado en V007). */
export type GeoAnomalyType =
  "DESVIO_RUTA_SIGNIFICATIVO" | "DETENCION_PROLONGADA";

/** Lectura GPS normalizada que consumen los detectores. */
export interface GpsSample {
  readonly id_gps: string;
  readonly id_viaje: string;
  readonly id_vehiculo: string;
  readonly placa: string;
  readonly latitud: number;
  readonly longitud: number;
  readonly velocidad_kmh: number;
  readonly fecha_hora: Date;
}

export interface StopGeofence {
  readonly id_parada: string;
  readonly nombre: string;
  readonly geocerca: GeoJsonPolygon;
}

/** Geometría de la ruta del viaje cacheada en memoria (polilínea simplificada + geocercas de parada). */
export interface TripRouteGeometry {
  readonly id_viaje: string;
  readonly id_ruta: string;
  readonly codigo_ruta: string;
  /** Polilínea simplificada (`ST_Simplify`) en orden GeoJSON [longitud, latitud]. */
  readonly polilinea_simplificada: readonly GeoJsonPosition[];
  readonly paradas: readonly StopGeofence[];
}

/** Resultado de la confirmación espacial exacta contra la polilínea oficial completa. */
export interface RouteDistanceMeasurement {
  readonly distancia_metros: number;
  /** `ST_DWithin(polilinea_oficial, punto, umbral)`. */
  readonly dentro_umbral: boolean;
}

export interface AnomalyEvaluationContext {
  readonly sample: GpsSample;
  /** Últimas lecturas del viaje (la más reciente al final), incluida `sample`. */
  readonly window: readonly GpsSample[];
  readonly route: TripRouteGeometry;
}

export interface AnomalyDetection {
  readonly tipo_incidente: GeoAnomalyType;
  readonly severidad: "CRITICO";
  readonly descripcion: string;
  readonly coordenadas: GeographicCoordinates;
  readonly fecha_hora: Date;
  readonly metricas: Readonly<Record<string, number>>;
}

export interface RecordGeoIncidentInput {
  readonly id_viaje: string;
  readonly tipo_incidente: GeoAnomalyType;
  readonly severidad: "CRITICO";
  readonly descripcion: string;
  readonly coordenadas: GeographicCoordinates;
}

export interface RecordedGeoIncident {
  readonly id_incidente: string;
  readonly fecha_hora: Date;
}

/** Payload emitido a la sala de Coordinación y publicado como evento de dominio. */
export interface RouteSecurityAlertPayload {
  readonly evento: "coordination:route_security_alert";
  readonly tipo_incidente: GeoAnomalyType;
  readonly severidad: "CRITICO";
  readonly id_incidente: string;
  readonly id_viaje: string;
  readonly id_ruta: string;
  readonly codigo_ruta: string;
  readonly id_vehiculo: string;
  readonly placa: string;
  readonly id_gps: string;
  readonly coordenadas: GeographicCoordinates;
  readonly metricas: Readonly<Record<string, number>>;
  readonly mensaje: string;
  readonly fecha_hora: string;
}
