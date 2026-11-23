import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  isValidGeoJsonPolygon,
  isValidLatitude,
  isValidLongitude,
  SAN_BENITO_GEOFENCE_CODE,
} from "./domain/geo.types";
import {
  GEO_PROXIMITY_QUERIES,
  IGeoProximityQueries,
} from "./domain/geo-proximity.port";
import {
  CreateZoneInput,
  IZoneRepository,
  UpdateZoneInput,
  ZONE_REPOSITORY,
} from "./domain/route-definition.port";
import {
  DuplicateZoneCodeError,
  GeofenceCheckResult,
  GeofenceZoneRecord,
  NearbyStopResult,
  ZoneType,
} from "./domain/route.entity";

/**
 * Servicio de administración de geocercas (`zona_geografica`) y consultas
 * espaciales GiST (`ST_DWithin`, `ST_Distance`, `ST_Contains`).
 * Consume exclusivamente `IGeoProximityQueries` e `IZoneRepository` (ISP).
 */
@Injectable()
export class GeoZonesService {
  constructor(
    @Inject(ZONE_REPOSITORY)
    private readonly zoneRepository: IZoneRepository,
    @Inject(GEO_PROXIMITY_QUERIES)
    private readonly proximityQueries: IGeoProximityQueries,
  ) {}

  async createZone(input: CreateZoneInput): Promise<GeofenceZoneRecord> {
    if (!isValidGeoJsonPolygon(input.poligono)) {
      throw new BadRequestException(
        "poligono debe ser un GeoJSON Polygon cerrado válido en WGS84 (SRID 4326).",
      );
    }

    try {
      return await this.zoneRepository.createZone(input);
    } catch (error) {
      if (error instanceof DuplicateZoneCodeError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  async listZones(filter?: {
    tipo_zona?: ZoneType;
    activa?: boolean;
  }): Promise<GeofenceZoneRecord[]> {
    return this.zoneRepository.listZones(filter);
  }

  async getZoneById(idZona: string): Promise<GeofenceZoneRecord> {
    const zone = await this.zoneRepository.findZoneById(idZona);
    if (!zone) {
      throw new NotFoundException(`Zona geográfica ${idZona} no encontrada.`);
    }
    return zone;
  }

  async getSanBenitoSchoolGeofence(): Promise<GeofenceZoneRecord> {
    const zone = await this.zoneRepository.findZoneByCode(
      SAN_BENITO_GEOFENCE_CODE,
    );
    if (!zone) {
      throw new NotFoundException(
        "La geocerca institucional del Colegio San Benito del Otún no está configurada.",
      );
    }
    return zone;
  }

  async updateZone(
    idZona: string,
    input: UpdateZoneInput,
  ): Promise<GeofenceZoneRecord> {
    if (
      input.poligono !== undefined &&
      !isValidGeoJsonPolygon(input.poligono)
    ) {
      throw new BadRequestException(
        "poligono debe ser un GeoJSON Polygon cerrado válido en WGS84 (SRID 4326).",
      );
    }

    const updated = await this.zoneRepository.updateZone(idZona, input);
    if (!updated) {
      throw new NotFoundException(`Zona geográfica ${idZona} no encontrada.`);
    }
    return updated;
  }

  async deleteZone(idZona: string): Promise<void> {
    const deleted = await this.zoneRepository.deleteZone(idZona);
    if (!deleted) {
      throw new NotFoundException(`Zona geográfica ${idZona} no encontrada.`);
    }
  }

  async findNearbyStops(
    latitud: number,
    longitud: number,
    radioMetros: number,
    idRuta?: string,
  ): Promise<NearbyStopResult[]> {
    this.assertValidCoordinates(latitud, longitud);
    if (!Number.isFinite(radioMetros) || radioMetros <= 0) {
      throw new BadRequestException(
        "radio_metros debe ser un número positivo.",
      );
    }
    return this.proximityQueries.findStopsWithinRadius(
      latitud,
      longitud,
      radioMetros,
      idRuta,
    );
  }

  async calculateDistanceMeters(
    origenLat: number,
    origenLng: number,
    destinoLat: number,
    destinoLng: number,
  ): Promise<{ distancia_metros: number; srid: 4326 }> {
    this.assertValidCoordinates(origenLat, origenLng);
    this.assertValidCoordinates(destinoLat, destinoLng);

    const distancia_metros =
      await this.proximityQueries.calculateDistanceBetweenPoints(
        { latitud: origenLat, longitud: origenLng },
        { latitud: destinoLat, longitud: destinoLng },
      );

    return { distancia_metros, srid: 4326 };
  }

  async checkPointInZones(
    latitud: number,
    longitud: number,
    tipoZona?: ZoneType,
  ): Promise<GeofenceCheckResult> {
    this.assertValidCoordinates(latitud, longitud);
    const zonas = await this.proximityQueries.findContainingZones(
      latitud,
      longitud,
      tipoZona,
    );

    return {
      dentro: zonas.length > 0,
      punto: { type: "Point", coordinates: [longitud, latitud] },
      zonas_coincidentes: zonas,
    };
  }

  async checkPointInSchoolGeofence(
    latitud: number,
    longitud: number,
  ): Promise<{ dentro: boolean; zona: GeofenceZoneRecord }> {
    this.assertValidCoordinates(latitud, longitud);
    const result = await this.proximityQueries.isPointInsideSchoolGeofence(
      latitud,
      longitud,
      SAN_BENITO_GEOFENCE_CODE,
    );
    if (!result.zona) {
      throw new NotFoundException(
        "La geocerca institucional del Colegio San Benito del Otún no está configurada.",
      );
    }
    return { dentro: result.dentro, zona: result.zona };
  }

  async checkPointInStopGeofence(
    idParada: string,
    latitud: number,
    longitud: number,
  ): Promise<{ id_parada: string; dentro: boolean; distancia_metros: number }> {
    this.assertValidCoordinates(latitud, longitud);
    const [dentro, distancia] = await Promise.all([
      this.proximityQueries.isPointInsideStopGeofence(
        idParada,
        latitud,
        longitud,
      ),
      this.proximityQueries.calculateDistanceToStop(
        idParada,
        latitud,
        longitud,
      ),
    ]);

    if (dentro === null || distancia === null) {
      throw new NotFoundException(`Parada ${idParada} no encontrada.`);
    }

    return {
      id_parada: idParada,
      dentro,
      distancia_metros: distancia,
    };
  }

  private assertValidCoordinates(latitud: number, longitud: number): void {
    if (!isValidLatitude(latitud) || !isValidLongitude(longitud)) {
      throw new BadRequestException(
        "Coordenadas WGS84 fuera de rango permitido (OWASP ASVS V5.1: lat [-90, 90], lng [-180, 180]).",
      );
    }
  }
}
