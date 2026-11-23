import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Roles } from "@common/decorators/roles.decorator";
import { RoleEnum } from "@common/enums/role.enum";
import { ParseUUIDv7Pipe } from "@common/pipes/parse-uuidv7.pipe";
import {
  IRouteDefinitionService,
  ROUTE_DEFINITION_SERVICE,
} from "./domain/route-definition.port";
import {
  CreateRouteAssignmentDto,
  CreateRouteDto,
  CreateStopDto,
  ListRoutesQueryDto,
  UpdateRouteDto,
  UpdateStopDto,
} from "./dto/route.dto";
import { RouteAssignmentService } from "./route-assignment.service";

const ROUTE_MANAGEMENT_ROLES = [
  RoleEnum.ADMIN,
  RoleEnum.RECTORIA,
  RoleEnum.GERENCIA_TRANSPORTE,
  RoleEnum.JEFE_OPERACIONES,
] as const;

const ROUTE_READ_ROLES = [
  ...ROUTE_MANAGEMENT_ROLES,
  RoleEnum.MONITORA,
  RoleEnum.CONDUCTOR,
  RoleEnum.ACUDIENTE,
] as const;

@ApiTags("Rutas Escolares y Paradas (PostGIS)")
@ApiBearerAuth()
@Controller("routes")
export class RoutesController {
  constructor(
    @Inject(ROUTE_DEFINITION_SERVICE)
    private readonly routesService: IRouteDefinitionService,
    private readonly assignmentService: RouteAssignmentService,
  ) {}

  @Post()
  @Roles(...ROUTE_MANAGEMENT_ROLES)
  @ApiOperation({
    summary:
      "Crear ruta escolar con trazado oficial GeoJSON LineString (SRID 4326)",
  })
  @ApiResponse({ status: 201, description: "Ruta escolar creada." })
  @ApiResponse({
    status: 400,
    description: "Geometría o referencias inválidas.",
  })
  @ApiResponse({ status: 409, description: "Código de ruta duplicado." })
  createRoute(@Body() dto: CreateRouteDto) {
    return this.routesService.createRoute(dto);
  }

  @Get()
  @Roles(...ROUTE_READ_ROLES)
  @ApiOperation({ summary: "Listar rutas escolares oficiales" })
  @ApiResponse({ status: 200, description: "Listado de rutas escolares." })
  listRoutes(@Query() query: ListRoutesQueryDto) {
    return this.routesService.listRoutes(query);
  }

  @Get(":id")
  @Roles(...ROUTE_READ_ROLES)
  @ApiOperation({
    summary:
      "Consultar ruta escolar con trazado GeoJSON y secuencia ordenada de paradas PostGIS GiST",
  })
  @ApiParam({ name: "id", description: "UUID de la ruta escolar" })
  @ApiResponse({ status: 200, description: "Detalle de la ruta obtenido." })
  @ApiResponse({ status: 404, description: "Ruta no encontrada." })
  getRoute(@Param("id", ParseUUIDv7Pipe) id: string) {
    return this.routesService.getRouteDetails(id);
  }

  @Patch(":id")
  @Roles(...ROUTE_MANAGEMENT_ROLES)
  @ApiOperation({
    summary: "Actualizar definición o trazado de una ruta escolar",
  })
  @ApiResponse({ status: 200, description: "Ruta actualizada." })
  @ApiResponse({ status: 404, description: "Ruta no encontrada." })
  updateRoute(
    @Param("id", ParseUUIDv7Pipe) id: string,
    @Body() dto: UpdateRouteDto,
  ) {
    return this.routesService.updateRoute(id, dto);
  }

  @Delete(":id")
  @Roles(...ROUTE_MANAGEMENT_ROLES)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Eliminar una ruta escolar sin dependencias activas",
  })
  @ApiResponse({ status: 204, description: "Ruta eliminada." })
  @ApiResponse({ status: 404, description: "Ruta no encontrada." })
  @ApiResponse({
    status: 409,
    description: "Ruta con asignaciones o viajes vinculados.",
  })
  deleteRoute(@Param("id", ParseUUIDv7Pipe) id: string) {
    return this.routesService.deleteRoute(id);
  }

  @Post(":id/stops")
  @Roles(...ROUTE_MANAGEMENT_ROLES)
  @ApiOperation({
    summary:
      "Agregar parada georreferenciada (Point + Polygon geocerca) en secuencia a la ruta",
  })
  @ApiResponse({ status: 201, description: "Parada creada." })
  @ApiResponse({
    status: 409,
    description: "orden_secuencia duplicado en la ruta.",
  })
  addStop(
    @Param("id", ParseUUIDv7Pipe) id: string,
    @Body() dto: CreateStopDto,
  ) {
    return this.routesService.addStop(id, dto);
  }

  @Get(":id/stops")
  @Roles(...ROUTE_READ_ROLES)
  @ApiOperation({ summary: "Listar paradas de una ruta en orden secuencial" })
  @ApiResponse({ status: 200, description: "Paradas ordenadas obtenidas." })
  listStops(@Param("id", ParseUUIDv7Pipe) id: string) {
    return this.routesService.listStopsByRoute(id);
  }

  @Patch(":id/stops/:stopId")
  @Roles(...ROUTE_MANAGEMENT_ROLES)
  @ApiOperation({ summary: "Actualizar parada o geocerca perimetral" })
  @ApiResponse({ status: 200, description: "Parada actualizada." })
  @ApiResponse({ status: 404, description: "Parada no encontrada en la ruta." })
  updateStop(
    @Param("id", ParseUUIDv7Pipe) id: string,
    @Param("stopId", ParseUUIDv7Pipe) stopId: string,
    @Body() dto: UpdateStopDto,
  ) {
    return this.routesService.updateStop(id, stopId, dto);
  }

  @Delete(":id/stops/:stopId")
  @Roles(...ROUTE_MANAGEMENT_ROLES)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Eliminar parada de una ruta" })
  @ApiResponse({ status: 204, description: "Parada eliminada." })
  @ApiResponse({ status: 404, description: "Parada no encontrada." })
  removeStop(
    @Param("id", ParseUUIDv7Pipe) id: string,
    @Param("stopId", ParseUUIDv7Pipe) stopId: string,
  ) {
    return this.routesService.removeStop(id, stopId);
  }

  @Post(":id/assignments")
  @Roles(...ROUTE_MANAGEMENT_ROLES)
  @ApiOperation({
    summary:
      "Asignar estudiante a ruta validando integridad compuesta (id_ruta, id_parada)",
  })
  @ApiResponse({ status: 201, description: "Asignación creada." })
  @ApiResponse({
    status: 422,
    description:
      "Violación de FK compuesta (id_ruta, id_parada): la parada no pertenece a la ruta.",
  })
  @ApiResponse({
    status: 409,
    description: "El estudiante ya posee asignación activa en esa franja.",
  })
  assignStudent(
    @Param("id", ParseUUIDv7Pipe) id: string,
    @Body() dto: CreateRouteAssignmentDto,
  ) {
    return this.assignmentService.assignStudentToRoute({
      id_ruta: id,
      ...dto,
    });
  }

  @Get(":id/assignments")
  @Roles(...ROUTE_MANAGEMENT_ROLES, RoleEnum.MONITORA)
  @ApiOperation({
    summary: "Listar asignaciones activas de estudiantes en una ruta",
  })
  @ApiResponse({ status: 200, description: "Asignaciones listadas." })
  listAssignments(@Param("id", ParseUUIDv7Pipe) id: string) {
    return this.assignmentService.listAssignmentsByRoute(id, true);
  }

  @Delete(":id/assignments/:assignmentId")
  @Roles(...ROUTE_MANAGEMENT_ROLES)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Desactivar asignación de estudiante en ruta" })
  @ApiResponse({ status: 204, description: "Asignación desactivada." })
  @ApiResponse({ status: 404, description: "Asignación no encontrada." })
  deactivateAssignment(
    @Param("id", ParseUUIDv7Pipe) id: string,
    @Param("assignmentId", ParseUUIDv7Pipe) assignmentId: string,
  ) {
    return this.assignmentService.deactivateAssignment(id, assignmentId);
  }
}
