import { GeoJsonLineString, GeoJsonPoint, GeoJsonPolygon } from "./geo.types";
import {
  AssignmentCycle,
  GeofenceZoneRecord,
  RouteAssignmentRecord,
  RouteRecord,
  RouteShift,
  RouteWithStops,
  StopRecord,
  ZoneType,
} from "./route.entity";

export interface CreateRouteInput {
  id_colegio: string;
  id_empresa: string;
  codigo: string;
  nombre: string;
  jornada: RouteShift;
  polilinea_oficial: GeoJsonLineString;
  origen_nombre: string;
  destino_nombre: string;
  activa?: boolean;
}

export interface UpdateRouteInput {
  nombre?: string;
  jornada?: RouteShift;
  polilinea_oficial?: GeoJsonLineString;
  origen_nombre?: string;
  destino_nombre?: string;
  activa?: boolean;
}

export interface ListRoutesFilter {
  id_colegio?: string;
  activa?: boolean;
}

export interface CreateStopInput {
  nombre: string;
  orden_secuencia: number;
  punto_geografico: GeoJsonPoint;
  horario_estimado: string;
  radio_geocerca?: GeoJsonPolygon;
  radio_metros?: number;
}

export interface UpdateStopInput {
  nombre?: string;
  orden_secuencia?: number;
  punto_geografico?: GeoJsonPoint;
  horario_estimado?: string;
  radio_geocerca?: GeoJsonPolygon;
  radio_metros?: number;
}

export interface CreateZoneInput {
  codigo?: string | null;
  id_colegio?: string | null;
  nombre: string;
  tipo_zona: ZoneType;
  poligono: GeoJsonPolygon;
  descripcion?: string | null;
  activa?: boolean;
}

export interface UpdateZoneInput {
  nombre?: string;
  tipo_zona?: ZoneType;
  poligono?: GeoJsonPolygon;
  descripcion?: string | null;
  activa?: boolean;
}

export interface CreateRouteAssignmentInput {
  id_estudiante: string;
  id_ruta: string;
  id_parada_subida: string;
  id_parada_bajada: string;
  ciclo_horario: AssignmentCycle;
}

/**
 * Puerto segregado de definición logística de rutas y paradas (ISP - Issue #6).
 * Permite que consumidores logísticos trabajen con rutas y paradas sin depender
 * de consultas espaciales complejas GIS (IGeoProximityQueries).
 */
export interface IRouteDefinitionService {
  createRoute(input: CreateRouteInput): Promise<RouteRecord>;
  listRoutes(filter?: ListRoutesFilter): Promise<RouteRecord[]>;
  getRouteDetails(idRuta: string): Promise<RouteWithStops>;
  updateRoute(idRuta: string, input: UpdateRouteInput): Promise<RouteRecord>;
  deleteRoute(idRuta: string): Promise<void>;
  addStop(idRuta: string, input: CreateStopInput): Promise<StopRecord>;
  listStopsByRoute(idRuta: string): Promise<StopRecord[]>;
  updateStop(
    idRuta: string,
    idParada: string,
    input: UpdateStopInput,
  ): Promise<StopRecord>;
  removeStop(idRuta: string, idParada: string): Promise<void>;
}

export interface IRouteRepository {
  createRoute(input: CreateRouteInput): Promise<RouteRecord>;
  findRouteById(idRuta: string): Promise<RouteRecord | null>;
  listRoutes(filter?: ListRoutesFilter): Promise<RouteRecord[]>;
  updateRoute(
    idRuta: string,
    input: UpdateRouteInput,
  ): Promise<RouteRecord | null>;
  deleteRoute(idRuta: string): Promise<boolean>;

  createStop(
    idRuta: string,
    input: Required<
      Pick<
        CreateStopInput,
        | "nombre"
        | "orden_secuencia"
        | "punto_geografico"
        | "horario_estimado"
        | "radio_geocerca"
      >
    >,
  ): Promise<StopRecord>;
  findStopById(idParada: string): Promise<StopRecord | null>;
  listStopsByRoute(idRuta: string): Promise<StopRecord[]>;
  updateStop(
    idRuta: string,
    idParada: string,
    input: Partial<
      Pick<
        StopRecord,
        | "nombre"
        | "orden_secuencia"
        | "punto_geografico"
        | "horario_estimado"
        | "radio_geocerca"
      >
    >,
  ): Promise<StopRecord | null>;
  deleteStop(idRuta: string, idParada: string): Promise<boolean>;
}

export interface IZoneRepository {
  createZone(input: CreateZoneInput): Promise<GeofenceZoneRecord>;
  findZoneById(idZona: string): Promise<GeofenceZoneRecord | null>;
  findZoneByCode(codigo: string): Promise<GeofenceZoneRecord | null>;
  listZones(filter?: {
    tipo_zona?: ZoneType;
    activa?: boolean;
  }): Promise<GeofenceZoneRecord[]>;
  updateZone(
    idZona: string,
    input: UpdateZoneInput,
  ): Promise<GeofenceZoneRecord | null>;
  deleteZone(idZona: string): Promise<boolean>;
}

export interface IRouteAssignmentRepository {
  createAssignment(
    input: CreateRouteAssignmentInput,
  ): Promise<RouteAssignmentRecord>;
  findAssignmentById(
    idAsignacion: string,
  ): Promise<RouteAssignmentRecord | null>;
  listAssignmentsByRoute(
    idRuta: string,
    soloActivas?: boolean,
  ): Promise<RouteAssignmentRecord[]>;
  listAssignmentsByStudent(
    idEstudiante: string,
    soloActivas?: boolean,
  ): Promise<RouteAssignmentRecord[]>;
  deactivateAssignment(idAsignacion: string): Promise<boolean>;
}

export const ROUTE_DEFINITION_SERVICE = Symbol("IRouteDefinitionService");
export const ROUTE_REPOSITORY = Symbol("IRouteRepository");
export const ZONE_REPOSITORY = Symbol("IZoneRepository");
export const ROUTE_ASSIGNMENT_REPOSITORY = Symbol("IRouteAssignmentRepository");
