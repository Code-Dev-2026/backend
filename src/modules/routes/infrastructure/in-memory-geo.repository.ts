import { Injectable } from "@nestjs/common";
import * as crypto from "crypto";
import {
  calculateHaversineDistanceMeters,
  GeographicCoordinates,
  isPointInGeoJsonPolygon,
  SAN_BENITO_GEOFENCE_CODE,
  SAN_BENITO_POLYGON,
  SAN_BENITO_SCHOOL_ID,
} from "../domain/geo.types";
import { IGeoProximityQueries } from "../domain/geo-proximity.port";
import {
  CreateRouteAssignmentInput,
  CreateRouteInput,
  CreateStopInput,
  CreateZoneInput,
  IRouteAssignmentRepository,
  IRouteRepository,
  IZoneRepository,
  ListRoutesFilter,
  UpdateRouteInput,
  UpdateZoneInput,
} from "../domain/route-definition.port";
import {
  CompositeStopRouteMismatchError,
  DuplicateActiveAssignmentError,
  DuplicateRouteCodeError,
  DuplicateStopSequenceError,
  DuplicateZoneCodeError,
  GeofenceZoneRecord,
  NearbyStopResult,
  RouteAssignmentRecord,
  RouteRecord,
  StopRecord,
  ZoneType,
} from "../domain/route.entity";

/**
 * Adaptador en memoria que replica fielmente las restricciones SQL de V004/V013
 * (incluyendo las claves foráneas compuestas `(id_ruta, id_parada)` y la geocerca
 * oficial del Colegio San Benito del Otún) para pruebas unitarias y arranque sin BD.
 * En producción/integración se reemplaza por `PostgisGeoRepository` sin tocar el dominio.
 */
@Injectable()
export class InMemoryGeoRepository
  implements
    IRouteRepository,
    IZoneRepository,
    IRouteAssignmentRepository,
    IGeoProximityQueries
{
  private readonly routes = new Map<string, RouteRecord>();
  private readonly stops = new Map<string, StopRecord>();
  private readonly zones = new Map<string, GeofenceZoneRecord>();
  private readonly assignments = new Map<string, RouteAssignmentRecord>();

  constructor() {
    this.seedSanBenitoGeofence();
  }

  reset(): void {
    this.routes.clear();
    this.stops.clear();
    this.zones.clear();
    this.assignments.clear();
    this.seedSanBenitoGeofence();
  }

  private seedSanBenitoGeofence(): void {
    const idZona = "018e38d9-3f00-7200-a000-000000000090";
    this.zones.set(idZona, {
      id_zona: idZona,
      codigo: SAN_BENITO_GEOFENCE_CODE,
      id_colegio: SAN_BENITO_SCHOOL_ID,
      nombre: "Sede Colegio San Benito del Otún",
      tipo_zona: ZoneType.GEOCERCA_ESCOLAR,
      poligono: structuredClone(SAN_BENITO_POLYGON),
      descripcion:
        "Geocerca perimetral oficial de la sede Colegio San Benito del Otún en Pereira, Risaralda (SRID 4326).",
      activa: true,
      creado_en: new Date("2026-01-01T00:00:00.000Z"),
    });
  }

  // --------------------------------------------------------------------------
  // RUTAS ESCOLARES
  // --------------------------------------------------------------------------

  async createRoute(input: CreateRouteInput): Promise<RouteRecord> {
    const normalizedCode = input.codigo.trim();
    for (const existing of this.routes.values()) {
      if (existing.codigo.toLowerCase() === normalizedCode.toLowerCase()) {
        throw new DuplicateRouteCodeError(normalizedCode);
      }
    }

    const record: RouteRecord = {
      id_ruta: crypto.randomUUID(),
      id_colegio: input.id_colegio,
      id_empresa: input.id_empresa,
      codigo: normalizedCode,
      nombre: input.nombre.trim(),
      jornada: input.jornada,
      polilinea_oficial: structuredClone(input.polilinea_oficial),
      origen_nombre: input.origen_nombre.trim(),
      destino_nombre: input.destino_nombre.trim(),
      activa: input.activa ?? true,
      creado_en: new Date(),
    };

    this.routes.set(record.id_ruta, record);
    return structuredClone(record);
  }

  async findRouteById(idRuta: string): Promise<RouteRecord | null> {
    const record = this.routes.get(idRuta);
    return record ? structuredClone(record) : null;
  }

  async listRoutes(filter?: ListRoutesFilter): Promise<RouteRecord[]> {
    return [...this.routes.values()]
      .filter((route) => {
        if (filter?.id_colegio && route.id_colegio !== filter.id_colegio) {
          return false;
        }
        if (filter?.activa !== undefined && route.activa !== filter.activa) {
          return false;
        }
        return true;
      })
      .sort((a, b) => a.codigo.localeCompare(b.codigo))
      .map((route) => structuredClone(route));
  }

  async updateRoute(
    idRuta: string,
    input: UpdateRouteInput,
  ): Promise<RouteRecord | null> {
    const existing = this.routes.get(idRuta);
    if (!existing) {
      return null;
    }

    const updated: RouteRecord = {
      ...existing,
      nombre:
        input.nombre !== undefined ? input.nombre.trim() : existing.nombre,
      jornada: input.jornada ?? existing.jornada,
      polilinea_oficial: input.polilinea_oficial
        ? structuredClone(input.polilinea_oficial)
        : existing.polilinea_oficial,
      origen_nombre:
        input.origen_nombre !== undefined
          ? input.origen_nombre.trim()
          : existing.origen_nombre,
      destino_nombre:
        input.destino_nombre !== undefined
          ? input.destino_nombre.trim()
          : existing.destino_nombre,
      activa: input.activa ?? existing.activa,
    };

    this.routes.set(idRuta, updated);
    return structuredClone(updated);
  }

  async deleteRoute(idRuta: string): Promise<boolean> {
    if (!this.routes.has(idRuta)) {
      return false;
    }
    this.routes.delete(idRuta);
    for (const [stopId, stop] of this.stops.entries()) {
      if (stop.id_ruta === idRuta) {
        this.stops.delete(stopId);
      }
    }
    return true;
  }

  // --------------------------------------------------------------------------
  // PARADAS OFICIALES
  // --------------------------------------------------------------------------

  async createStop(
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
  ): Promise<StopRecord> {
    for (const existing of this.stops.values()) {
      if (
        existing.id_ruta === idRuta &&
        existing.orden_secuencia === input.orden_secuencia
      ) {
        throw new DuplicateStopSequenceError(idRuta, input.orden_secuencia);
      }
    }

    const [longitud, latitud] = input.punto_geografico.coordinates;
    const record: StopRecord = {
      id_parada: crypto.randomUUID(),
      id_ruta: idRuta,
      nombre: input.nombre.trim(),
      orden_secuencia: input.orden_secuencia,
      punto_geografico: structuredClone(input.punto_geografico),
      horario_estimado: input.horario_estimado,
      radio_geocerca: structuredClone(input.radio_geocerca),
      latitud,
      longitud,
    };

    this.stops.set(record.id_parada, record);
    return structuredClone(record);
  }

  async findStopById(idParada: string): Promise<StopRecord | null> {
    const stop = this.stops.get(idParada);
    return stop ? structuredClone(stop) : null;
  }

  async listStopsByRoute(idRuta: string): Promise<StopRecord[]> {
    return [...this.stops.values()]
      .filter((stop) => stop.id_ruta === idRuta)
      .sort((a, b) => a.orden_secuencia - b.orden_secuencia)
      .map((stop) => structuredClone(stop));
  }

  async updateStop(
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
  ): Promise<StopRecord | null> {
    const existing = this.stops.get(idParada);
    if (!existing || existing.id_ruta !== idRuta) {
      return null;
    }

    if (
      input.orden_secuencia !== undefined &&
      input.orden_secuencia !== existing.orden_secuencia
    ) {
      for (const other of this.stops.values()) {
        if (
          other.id_ruta === idRuta &&
          other.id_parada !== idParada &&
          other.orden_secuencia === input.orden_secuencia
        ) {
          throw new DuplicateStopSequenceError(idRuta, input.orden_secuencia);
        }
      }
    }

    const punto = input.punto_geografico
      ? structuredClone(input.punto_geografico)
      : existing.punto_geografico;
    const [longitud, latitud] = punto.coordinates;

    const updated: StopRecord = {
      ...existing,
      nombre:
        input.nombre !== undefined ? input.nombre.trim() : existing.nombre,
      orden_secuencia: input.orden_secuencia ?? existing.orden_secuencia,
      punto_geografico: punto,
      horario_estimado: input.horario_estimado ?? existing.horario_estimado,
      radio_geocerca: input.radio_geocerca
        ? structuredClone(input.radio_geocerca)
        : existing.radio_geocerca,
      latitud,
      longitud,
    };

    this.stops.set(idParada, updated);
    return structuredClone(updated);
  }

  async deleteStop(idRuta: string, idParada: string): Promise<boolean> {
    const existing = this.stops.get(idParada);
    if (!existing || existing.id_ruta !== idRuta) {
      return false;
    }
    this.stops.delete(idParada);
    return true;
  }

  // --------------------------------------------------------------------------
  // ZONAS GEOGRÁFICAS Y GEOCERCAS
  // --------------------------------------------------------------------------

  async createZone(input: CreateZoneInput): Promise<GeofenceZoneRecord> {
    const codigo = input.codigo?.trim() ?? null;
    if (codigo) {
      for (const existing of this.zones.values()) {
        if (existing.codigo === codigo) {
          throw new DuplicateZoneCodeError(codigo);
        }
      }
    }

    const record: GeofenceZoneRecord = {
      id_zona: crypto.randomUUID(),
      codigo,
      id_colegio: input.id_colegio ?? null,
      nombre: input.nombre.trim(),
      tipo_zona: input.tipo_zona,
      poligono: structuredClone(input.poligono),
      descripcion: input.descripcion?.trim() ?? null,
      activa: input.activa ?? true,
      creado_en: new Date(),
    };

    this.zones.set(record.id_zona, record);
    return structuredClone(record);
  }

  async findZoneById(idZona: string): Promise<GeofenceZoneRecord | null> {
    const zone = this.zones.get(idZona);
    return zone ? structuredClone(zone) : null;
  }

  async findZoneByCode(codigo: string): Promise<GeofenceZoneRecord | null> {
    for (const zone of this.zones.values()) {
      if (zone.codigo === codigo) {
        return structuredClone(zone);
      }
    }
    return null;
  }

  async listZones(filter?: {
    tipo_zona?: ZoneType;
    activa?: boolean;
  }): Promise<GeofenceZoneRecord[]> {
    return [...this.zones.values()]
      .filter((zone) => {
        if (filter?.tipo_zona && zone.tipo_zona !== filter.tipo_zona) {
          return false;
        }
        if (filter?.activa !== undefined && zone.activa !== filter.activa) {
          return false;
        }
        return true;
      })
      .sort((a, b) => a.nombre.localeCompare(b.nombre))
      .map((zone) => structuredClone(zone));
  }

  async updateZone(
    idZona: string,
    input: UpdateZoneInput,
  ): Promise<GeofenceZoneRecord | null> {
    const existing = this.zones.get(idZona);
    if (!existing) {
      return null;
    }

    const updated: GeofenceZoneRecord = {
      ...existing,
      nombre:
        input.nombre !== undefined ? input.nombre.trim() : existing.nombre,
      tipo_zona: input.tipo_zona ?? existing.tipo_zona,
      poligono: input.poligono
        ? structuredClone(input.poligono)
        : existing.poligono,
      descripcion:
        input.descripcion !== undefined
          ? (input.descripcion?.trim() ?? null)
          : existing.descripcion,
      activa: input.activa ?? existing.activa,
    };

    this.zones.set(idZona, updated);
    return structuredClone(updated);
  }

  async deleteZone(idZona: string): Promise<boolean> {
    return this.zones.delete(idZona);
  }

  // --------------------------------------------------------------------------
  // ASIGNACIÓN DE ESTUDIANTE A RUTA (FK compuesta (id_ruta, id_parada))
  // --------------------------------------------------------------------------

  async createAssignment(
    input: CreateRouteAssignmentInput,
  ): Promise<RouteAssignmentRecord> {
    const stopBoarding = this.stops.get(input.id_parada_subida);
    if (!stopBoarding || stopBoarding.id_ruta !== input.id_ruta) {
      throw new CompositeStopRouteMismatchError(
        "fk_asignacion_subida_compuesta",
        input.id_ruta,
        input.id_parada_subida,
      );
    }

    const stopAlighting = this.stops.get(input.id_parada_bajada);
    if (!stopAlighting || stopAlighting.id_ruta !== input.id_ruta) {
      throw new CompositeStopRouteMismatchError(
        "fk_asignacion_bajada_compuesta",
        input.id_ruta,
        input.id_parada_bajada,
      );
    }

    for (const existing of this.assignments.values()) {
      if (
        existing.activa &&
        existing.id_estudiante === input.id_estudiante &&
        existing.ciclo_horario === input.ciclo_horario
      ) {
        throw new DuplicateActiveAssignmentError(
          input.id_estudiante,
          input.ciclo_horario,
        );
      }
    }

    const record: RouteAssignmentRecord = {
      id_asignacion: crypto.randomUUID(),
      id_estudiante: input.id_estudiante,
      id_ruta: input.id_ruta,
      id_parada_subida: input.id_parada_subida,
      id_parada_bajada: input.id_parada_bajada,
      ciclo_horario: input.ciclo_horario,
      activa: true,
      fecha_asignacion: new Date(),
    };

    this.assignments.set(record.id_asignacion, record);
    return structuredClone(record);
  }

  async findAssignmentById(
    idAsignacion: string,
  ): Promise<RouteAssignmentRecord | null> {
    const assignment = this.assignments.get(idAsignacion);
    return assignment ? structuredClone(assignment) : null;
  }

  async listAssignmentsByRoute(
    idRuta: string,
    soloActivas = true,
  ): Promise<RouteAssignmentRecord[]> {
    return [...this.assignments.values()]
      .filter(
        (assignment) =>
          assignment.id_ruta === idRuta && (!soloActivas || assignment.activa),
      )
      .map((assignment) => structuredClone(assignment));
  }

  async listAssignmentsByStudent(
    idEstudiante: string,
    soloActivas = true,
  ): Promise<RouteAssignmentRecord[]> {
    return [...this.assignments.values()]
      .filter(
        (assignment) =>
          assignment.id_estudiante === idEstudiante &&
          (!soloActivas || assignment.activa),
      )
      .map((assignment) => structuredClone(assignment));
  }

  async deactivateAssignment(idAsignacion: string): Promise<boolean> {
    const existing = this.assignments.get(idAsignacion);
    if (!existing || !existing.activa) {
      return false;
    }
    this.assignments.set(idAsignacion, { ...existing, activa: false });
    return true;
  }

  // --------------------------------------------------------------------------
  // CONSULTAS ESPACIALES (IGeoProximityQueries)
  // --------------------------------------------------------------------------

  async findStopsWithinRadius(
    latitud: number,
    longitud: number,
    radioMetros: number,
    idRuta?: string,
  ): Promise<NearbyStopResult[]> {
    const origin: GeographicCoordinates = { latitud, longitud };
    return [...this.stops.values()]
      .filter((stop) => !idRuta || stop.id_ruta === idRuta)
      .map((stop) => ({
        ...structuredClone(stop),
        distancia_metros: calculateHaversineDistanceMeters(origin, {
          latitud: stop.latitud,
          longitud: stop.longitud,
        }),
      }))
      .filter((stop) => stop.distancia_metros <= radioMetros)
      .sort(
        (a, b) =>
          a.distancia_metros - b.distancia_metros ||
          a.orden_secuencia - b.orden_secuencia,
      );
  }

  async calculateDistanceBetweenPoints(
    origen: GeographicCoordinates,
    destino: GeographicCoordinates,
  ): Promise<number> {
    return calculateHaversineDistanceMeters(origen, destino);
  }

  async calculateDistanceToStop(
    idParada: string,
    latitud: number,
    longitud: number,
  ): Promise<number | null> {
    const stop = this.stops.get(idParada);
    if (!stop) {
      return null;
    }
    return calculateHaversineDistanceMeters(
      { latitud, longitud },
      { latitud: stop.latitud, longitud: stop.longitud },
    );
  }

  async isPointInsideStopGeofence(
    idParada: string,
    latitud: number,
    longitud: number,
  ): Promise<boolean | null> {
    const stop = this.stops.get(idParada);
    if (!stop) {
      return null;
    }
    return isPointInGeoJsonPolygon(latitud, longitud, stop.radio_geocerca);
  }

  async isPointInsideZone(
    idZona: string,
    latitud: number,
    longitud: number,
  ): Promise<boolean | null> {
    const zone = this.zones.get(idZona);
    if (!zone) {
      return null;
    }
    return isPointInGeoJsonPolygon(latitud, longitud, zone.poligono);
  }

  async findContainingZones(
    latitud: number,
    longitud: number,
    tipoZona?: ZoneType,
  ): Promise<GeofenceZoneRecord[]> {
    return [...this.zones.values()]
      .filter((zone) => {
        if (!zone.activa) {
          return false;
        }
        if (tipoZona && zone.tipo_zona !== tipoZona) {
          return false;
        }
        return isPointInGeoJsonPolygon(latitud, longitud, zone.poligono);
      })
      .sort((a, b) => a.nombre.localeCompare(b.nombre))
      .map((zone) => structuredClone(zone));
  }

  async isPointInsideSchoolGeofence(
    latitud: number,
    longitud: number,
    codigo: string = SAN_BENITO_GEOFENCE_CODE,
  ): Promise<{ dentro: boolean; zona: GeofenceZoneRecord | null }> {
    const zona = await this.findZoneByCode(codigo);
    if (!zona || !zona.activa) {
      return { dentro: false, zona };
    }
    const dentro = isPointInGeoJsonPolygon(latitud, longitud, zona.poligono);
    return { dentro, zona };
  }
}
