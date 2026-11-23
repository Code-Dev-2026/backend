import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Roles } from "@common/decorators/roles.decorator";
import { RoleEnum } from "@common/enums/role.enum";
import { ParseUUIDv7Pipe } from "@common/pipes/parse-uuidv7.pipe";
import {
  CalculateDistanceDto,
  CheckGeofenceContainmentDto,
  CreateGeofenceZoneDto,
  ListZonesQueryDto,
  NearbyStopsQueryDto,
  UpdateGeofenceZoneDto,
} from "./dto/geo-zone.dto";
import { GeoZonesService } from "./geo-zones.service";

const GEO_MANAGEMENT_ROLES = [
  RoleEnum.ADMIN,
  RoleEnum.RECTORIA,
  RoleEnum.GERENCIA_TRANSPORTE,
  RoleEnum.JEFE_OPERACIONES,
] as const;

const GEO_READ_ROLES = [
  ...GEO_MANAGEMENT_ROLES,
  RoleEnum.MONITORA,
  RoleEnum.CONDUCTOR,
  RoleEnum.ACUDIENTE,
] as const;

@ApiTags("Geocercas y Proximidad Espacial (PostGIS GiST)")
@ApiBearerAuth()
@Controller("geo")
export class GeoZonesController {
  constructor(private readonly geoZonesService: GeoZonesService) {}

  @Post("zones")
  @Roles(...GEO_MANAGEMENT_ROLES)
  @ApiOperation({
    summary:
      "Crear zona geográfica o geocerca con polígono GeoJSON (SRID 4326)",
  })
  @ApiResponse({ status: 201, description: "Zona geográfica creada." })
  @ApiResponse({ status: 400, description: "Polígono GeoJSON inválido." })
  @ApiResponse({ status: 409, description: "Código de zona duplicado." })
  createZone(@Body() dto: CreateGeofenceZoneDto) {
    return this.geoZonesService.createZone(dto);
  }

  @Get("zones")
  @Roles(...GEO_READ_ROLES)
  @ApiOperation({
    summary: "Listar zonas geográficas y geocercas configuradas",
  })
  @ApiResponse({ status: 200, description: "Zonas listadas." })
  listZones(@Query() query: ListZonesQueryDto) {
    return this.geoZonesService.listZones(query);
  }

  @Get("zones/school-geofence")
  @Roles(...GEO_READ_ROLES)
  @ApiOperation({
    summary:
      "Consultar la geocerca oficial de la sede Colegio San Benito del Otún",
  })
  @ApiResponse({ status: 200, description: "Geocerca escolar encontrada." })
  @ApiResponse({ status: 404, description: "Geocerca escolar no configurada." })
  getSchoolGeofence() {
    return this.geoZonesService.getSanBenitoSchoolGeofence();
  }

  @Get("zones/:id")
  @Roles(...GEO_READ_ROLES)
  @ApiOperation({ summary: "Consultar una zona geográfica por UUID" })
  @ApiResponse({ status: 200, description: "Zona encontrada." })
  @ApiResponse({ status: 404, description: "Zona no encontrada." })
  getZone(@Param("id", ParseUUIDv7Pipe) id: string) {
    return this.geoZonesService.getZoneById(id);
  }

  @Patch("zones/:id")
  @Roles(...GEO_MANAGEMENT_ROLES)
  @ApiOperation({ summary: "Actualizar zona geográfica o geocerca" })
  @ApiResponse({ status: 200, description: "Zona actualizada." })
  @ApiResponse({ status: 404, description: "Zona no encontrada." })
  updateZone(
    @Param("id", ParseUUIDv7Pipe) id: string,
    @Body() dto: UpdateGeofenceZoneDto,
  ) {
    return this.geoZonesService.updateZone(id, dto);
  }

  @Delete("zones/:id")
  @Roles(...GEO_MANAGEMENT_ROLES)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Eliminar zona geográfica" })
  @ApiResponse({ status: 204, description: "Zona eliminada." })
  @ApiResponse({ status: 404, description: "Zona no encontrada." })
  deleteZone(@Param("id", ParseUUIDv7Pipe) id: string) {
    return this.geoZonesService.deleteZone(id);
  }

  @Get("proximity/stops")
  @Roles(...GEO_READ_ROLES)
  @ApiOperation({
    summary:
      "Buscar paradas cercanas dentro de un radio en metros (ST_DWithin + ST_Distance GiST)",
  })
  @ApiResponse({
    status: 200,
    description: "Paradas cercanas ordenadas por distancia.",
  })
  findNearbyStops(@Query() query: NearbyStopsQueryDto) {
    return this.geoZonesService.findNearbyStops(
      query.latitud,
      query.longitud,
      query.radio_metros,
      query.id_ruta,
    );
  }

  @Post("proximity/distance")
  @HttpCode(HttpStatus.OK)
  @Roles(...GEO_READ_ROLES)
  @ApiOperation({
    summary:
      "Calcular distancia geodésica en metros entre dos coordenadas WGS84 (ST_Distance)",
  })
  @ApiResponse({ status: 200, description: "Distancia calculada en metros." })
  calculateDistance(@Body() dto: CalculateDistanceDto) {
    return this.geoZonesService.calculateDistanceMeters(
      dto.origen_latitud,
      dto.origen_longitud,
      dto.destino_latitud,
      dto.destino_longitud,
    );
  }

  @Post("proximity/contains")
  @HttpCode(HttpStatus.OK)
  @Roles(...GEO_READ_ROLES)
  @ApiOperation({
    summary:
      "Verificar si una coordenada WGS84 está contenida en zonas o geocercas activas (ST_Contains + GiST)",
  })
  @ApiResponse({
    status: 200,
    description: "Resultado de contención espacial.",
  })
  checkContainment(@Body() dto: CheckGeofenceContainmentDto) {
    return this.geoZonesService.checkPointInZones(
      dto.latitud,
      dto.longitud,
      dto.tipo_zona,
    );
  }

  @Post("proximity/school-geofence/check")
  @HttpCode(HttpStatus.OK)
  @Roles(...GEO_READ_ROLES)
  @ApiOperation({
    summary:
      "Verificar si una coordenada está dentro de la geocerca del Colegio San Benito del Otún",
  })
  @ApiResponse({ status: 200, description: "Resultado de geocerca escolar." })
  checkSchoolGeofence(@Body() dto: CheckGeofenceContainmentDto) {
    return this.geoZonesService.checkPointInSchoolGeofence(
      dto.latitud,
      dto.longitud,
    );
  }

  @Post("proximity/stops/:stopId/contains")
  @HttpCode(HttpStatus.OK)
  @Roles(...GEO_READ_ROLES)
  @ApiOperation({
    summary:
      "Verificar si una coordenada está dentro de la geocerca perimetral de una parada oficial",
  })
  @ApiResponse({ status: 200, description: "Estado respecto a la parada." })
  @ApiResponse({ status: 404, description: "Parada no encontrada." })
  checkStopGeofence(
    @Param("stopId", ParseUUIDv7Pipe) stopId: string,
    @Body() dto: CheckGeofenceContainmentDto,
  ) {
    return this.geoZonesService.checkPointInStopGeofence(
      stopId,
      dto.latitud,
      dto.longitud,
    );
  }
}
