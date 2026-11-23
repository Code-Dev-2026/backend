import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  createCircularGeofencePolygon,
  isValidGeoJsonLineString,
  isValidGeoJsonPoint,
  isValidGeoJsonPolygon,
  WGS84_SRID,
} from "./domain/geo.types";
import {
  CreateRouteInput,
  CreateStopInput,
  IRouteDefinitionService,
  IRouteRepository,
  ListRoutesFilter,
  ROUTE_REPOSITORY,
  UpdateRouteInput,
  UpdateStopInput,
} from "./domain/route-definition.port";
import {
  DuplicateRouteCodeError,
  DuplicateStopSequenceError,
  ForeignKeyReferenceError,
  RouteRecord,
  RouteWithStops,
  StopRecord,
} from "./domain/route.entity";

const DEFAULT_STOP_GEOFENCE_RADIUS_METERS = 100;

/**
 * Servicio logístico de definición de rutas escolares y paradas oficiales.
 * Implementa exclusivamente `IRouteDefinitionService` (ISP - Issue #6),
 * desacoplado de las consultas espaciales complejas GIS (`IGeoProximityQueries`).
 */
@Injectable()
export class RoutesService implements IRouteDefinitionService {
  constructor(
    @Inject(ROUTE_REPOSITORY)
    private readonly routeRepository: IRouteRepository,
  ) {}

  async createRoute(input: CreateRouteInput): Promise<RouteRecord> {
    if (!isValidGeoJsonLineString(input.polilinea_oficial)) {
      throw new BadRequestException(
        "polilinea_oficial debe ser un GeoJSON LineString válido en WGS84 (SRID 4326).",
      );
    }

    try {
      return await this.routeRepository.createRoute(input);
    } catch (error) {
      if (error instanceof DuplicateRouteCodeError) {
        throw new ConflictException(error.message);
      }
      if (error instanceof ForeignKeyReferenceError) {
        throw new BadRequestException(
          `Colegio o empresa transportadora inexistente (${error.constraint}).`,
        );
      }
      throw error;
    }
  }

  async listRoutes(filter?: ListRoutesFilter): Promise<RouteRecord[]> {
    return this.routeRepository.listRoutes(filter);
  }

  async getRouteDetails(idRuta: string): Promise<RouteWithStops> {
    const route = await this.routeRepository.findRouteById(idRuta);
    if (!route) {
      throw new NotFoundException(`Ruta ${idRuta} no encontrada.`);
    }

    const paradas = await this.routeRepository.listStopsByRoute(idRuta);
    return {
      ...route,
      srid: WGS84_SRID,
      paradas,
    };
  }

  async updateRoute(
    idRuta: string,
    input: UpdateRouteInput,
  ): Promise<RouteRecord> {
    if (
      input.polilinea_oficial !== undefined &&
      !isValidGeoJsonLineString(input.polilinea_oficial)
    ) {
      throw new BadRequestException(
        "polilinea_oficial debe ser un GeoJSON LineString válido en WGS84 (SRID 4326).",
      );
    }

    const updated = await this.routeRepository.updateRoute(idRuta, input);
    if (!updated) {
      throw new NotFoundException(`Ruta ${idRuta} no encontrada.`);
    }
    return updated;
  }

  async deleteRoute(idRuta: string): Promise<void> {
    try {
      const deleted = await this.routeRepository.deleteRoute(idRuta);
      if (!deleted) {
        throw new NotFoundException(`Ruta ${idRuta} no encontrada.`);
      }
    } catch (error) {
      if (error instanceof ForeignKeyReferenceError) {
        throw new ConflictException(
          "No se puede eliminar la ruta porque tiene asignaciones o viajes asociados.",
        );
      }
      throw error;
    }
  }

  async addStop(idRuta: string, input: CreateStopInput): Promise<StopRecord> {
    const route = await this.routeRepository.findRouteById(idRuta);
    if (!route) {
      throw new NotFoundException(`Ruta ${idRuta} no encontrada.`);
    }

    if (!Number.isInteger(input.orden_secuencia) || input.orden_secuencia < 1) {
      throw new BadRequestException(
        "orden_secuencia debe ser un entero positivo mayor o igual a 1.",
      );
    }

    if (!isValidGeoJsonPoint(input.punto_geografico)) {
      throw new BadRequestException(
        "punto_geografico debe ser un GeoJSON Point válido en WGS84 (lat [-90,90], lng [-180,180]).",
      );
    }

    const [longitud, latitud] = input.punto_geografico.coordinates;
    const radioGeocerca =
      input.radio_geocerca ??
      createCircularGeofencePolygon(
        latitud,
        longitud,
        input.radio_metros ?? DEFAULT_STOP_GEOFENCE_RADIUS_METERS,
      );

    if (!isValidGeoJsonPolygon(radioGeocerca)) {
      throw new BadRequestException(
        "radio_geocerca debe ser un GeoJSON Polygon cerrado válido en WGS84.",
      );
    }

    try {
      return await this.routeRepository.createStop(idRuta, {
        nombre: input.nombre,
        orden_secuencia: input.orden_secuencia,
        punto_geografico: input.punto_geografico,
        horario_estimado: input.horario_estimado,
        radio_geocerca: radioGeocerca,
      });
    } catch (error) {
      if (error instanceof DuplicateStopSequenceError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  async listStopsByRoute(idRuta: string): Promise<StopRecord[]> {
    const route = await this.routeRepository.findRouteById(idRuta);
    if (!route) {
      throw new NotFoundException(`Ruta ${idRuta} no encontrada.`);
    }
    return this.routeRepository.listStopsByRoute(idRuta);
  }

  async updateStop(
    idRuta: string,
    idParada: string,
    input: UpdateStopInput,
  ): Promise<StopRecord> {
    const existing = await this.routeRepository.findStopById(idParada);
    if (!existing || existing.id_ruta !== idRuta) {
      throw new NotFoundException(
        `Parada ${idParada} no encontrada en la ruta ${idRuta}.`,
      );
    }

    if (
      input.orden_secuencia !== undefined &&
      (!Number.isInteger(input.orden_secuencia) || input.orden_secuencia < 1)
    ) {
      throw new BadRequestException(
        "orden_secuencia debe ser un entero positivo mayor o igual a 1.",
      );
    }

    if (
      input.punto_geografico !== undefined &&
      !isValidGeoJsonPoint(input.punto_geografico)
    ) {
      throw new BadRequestException(
        "punto_geografico debe ser un GeoJSON Point válido en WGS84.",
      );
    }

    let radioGeocerca = input.radio_geocerca;
    if (!radioGeocerca && input.radio_metros !== undefined) {
      const targetPoint = input.punto_geografico ?? existing.punto_geografico;
      const [lng, lat] = targetPoint.coordinates;
      radioGeocerca = createCircularGeofencePolygon(
        lat,
        lng,
        input.radio_metros,
      );
    }

    if (radioGeocerca !== undefined && !isValidGeoJsonPolygon(radioGeocerca)) {
      throw new BadRequestException(
        "radio_geocerca debe ser un GeoJSON Polygon cerrado válido en WGS84.",
      );
    }

    try {
      const updated = await this.routeRepository.updateStop(idRuta, idParada, {
        nombre: input.nombre,
        orden_secuencia: input.orden_secuencia,
        punto_geografico: input.punto_geografico,
        horario_estimado: input.horario_estimado,
        radio_geocerca: radioGeocerca,
      });
      if (!updated) {
        throw new NotFoundException(
          `Parada ${idParada} no encontrada en la ruta ${idRuta}.`,
        );
      }
      return updated;
    } catch (error) {
      if (error instanceof DuplicateStopSequenceError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  async removeStop(idRuta: string, idParada: string): Promise<void> {
    try {
      const deleted = await this.routeRepository.deleteStop(idRuta, idParada);
      if (!deleted) {
        throw new NotFoundException(
          `Parada ${idParada} no encontrada en la ruta ${idRuta}.`,
        );
      }
    } catch (error) {
      if (error instanceof ForeignKeyReferenceError) {
        throw new ConflictException(
          "No se puede eliminar la parada porque está asignada a uno o más estudiantes.",
        );
      }
      throw error;
    }
  }
}
