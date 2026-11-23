import {
  GeoJsonLineString,
  GeoJsonPoint,
  GeoJsonPolygon,
  WGS84_SRID,
} from "./geo.types";

export enum RouteShift {
  MANANA = "MANANA",
  TARDE = "TARDE",
  COMPLETA = "COMPLETA",
}

export enum AssignmentCycle {
  IDA = "IDA",
  RETORNO = "RETORNO",
  AMBOS = "AMBOS",
}

export enum ZoneType {
  SOMBRA_CELULAR = "SOMBRA_CELULAR",
  GEOCERCA_ESCOLAR = "GEOCERCA_ESCOLAR",
  PERIMETRO_MUNICIPAL = "PERIMETRO_MUNICIPAL",
}

export interface RouteRecord {
  id_ruta: string;
  id_colegio: string;
  id_empresa: string;
  codigo: string;
  nombre: string;
  jornada: RouteShift;
  polilinea_oficial: GeoJsonLineString;
  origen_nombre: string;
  destino_nombre: string;
  activa: boolean;
  creado_en: Date;
}

export interface StopRecord {
  id_parada: string;
  id_ruta: string;
  nombre: string;
  orden_secuencia: number;
  punto_geografico: GeoJsonPoint;
  horario_estimado: string;
  radio_geocerca: GeoJsonPolygon;
  latitud: number;
  longitud: number;
}

export interface RouteWithStops extends RouteRecord {
  srid: typeof WGS84_SRID;
  paradas: StopRecord[];
}

export interface GeofenceZoneRecord {
  id_zona: string;
  codigo: string | null;
  id_colegio: string | null;
  nombre: string;
  tipo_zona: ZoneType;
  poligono: GeoJsonPolygon;
  descripcion: string | null;
  activa: boolean;
  creado_en: Date;
}

export interface RouteAssignmentRecord {
  id_asignacion: string;
  id_estudiante: string;
  id_ruta: string;
  id_parada_subida: string;
  id_parada_bajada: string;
  ciclo_horario: AssignmentCycle;
  activa: boolean;
  fecha_asignacion: Date;
}

export interface NearbyStopResult extends StopRecord {
  distancia_metros: number;
}

export interface GeofenceCheckResult {
  dentro: boolean;
  punto: GeoJsonPoint;
  zonas_coincidentes: GeofenceZoneRecord[];
}

export class DuplicateRouteCodeError extends Error {
  constructor(readonly codigo: string) {
    super(`Ya existe una ruta registrada con el código '${codigo}'.`);
  }
}

export class DuplicateStopSequenceError extends Error {
  constructor(
    readonly id_ruta: string,
    readonly orden_secuencia: number,
  ) {
    super(
      `Ya existe una parada con secuencia ${orden_secuencia} en la ruta ${id_ruta}.`,
    );
  }
}

export class DuplicateZoneCodeError extends Error {
  constructor(readonly codigo: string) {
    super(`Ya existe una zona geográfica con el código '${codigo}'.`);
  }
}

export class DuplicateActiveAssignmentError extends Error {
  constructor(
    readonly id_estudiante: string,
    readonly ciclo_horario: AssignmentCycle,
  ) {
    super(
      `El estudiante ${id_estudiante} ya tiene una asignación activa en la franja ${ciclo_horario}.`,
    );
  }
}

/**
 * Representa la violación de llave foránea compuesta (id_ruta, id_parada) en `asignacion_ruta`
 * (constraints `fk_asignacion_subida_compuesta` / `fk_asignacion_bajada_compuesta`).
 */
export class CompositeStopRouteMismatchError extends Error {
  constructor(
    readonly constraint:
      "fk_asignacion_subida_compuesta" | "fk_asignacion_bajada_compuesta",
    readonly id_ruta: string,
    readonly id_parada: string,
  ) {
    super(
      `Integridad referencial compuesta violada (${constraint}): la parada ${id_parada} no pertenece a la ruta ${id_ruta}.`,
    );
  }
}

export class ForeignKeyReferenceError extends Error {
  constructor(readonly constraint: string) {
    super(`Referencia foránea inválida: ${constraint}.`);
  }
}

export class InvalidGeometryError extends Error {
  constructor(message: string) {
    super(message);
  }
}
