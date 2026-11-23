import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  CreateRouteAssignmentInput,
  IRouteAssignmentRepository,
  IRouteRepository,
  ROUTE_ASSIGNMENT_REPOSITORY,
  ROUTE_REPOSITORY,
} from "./domain/route-definition.port";
import {
  CompositeStopRouteMismatchError,
  DuplicateActiveAssignmentError,
  ForeignKeyReferenceError,
  RouteAssignmentRecord,
} from "./domain/route.entity";

/**
 * Servicio de validación de asignación de estudiantes a rutas escolares (RF-04).
 * Garantiza coherencia biunívoca estudiante-ruta-paradas y delega la integridad
 * matemática final a las llaves foráneas compuestas `(id_ruta, id_parada)` de PostgreSQL.
 */
@Injectable()
export class RouteAssignmentService {
  constructor(
    @Inject(ROUTE_REPOSITORY)
    private readonly routeRepository: IRouteRepository,
    @Inject(ROUTE_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepository: IRouteAssignmentRepository,
  ) {}

  async assignStudentToRoute(
    input: CreateRouteAssignmentInput,
  ): Promise<RouteAssignmentRecord> {
    const route = await this.routeRepository.findRouteById(input.id_ruta);
    if (!route) {
      throw new NotFoundException(`Ruta ${input.id_ruta} no encontrada.`);
    }

    if (!route.activa) {
      throw new BadRequestException(
        `La ruta ${route.codigo} está inactiva y no admite nuevas asignaciones.`,
      );
    }

    try {
      // Se delega la inserción al repositorio para que la FK compuesta
      // (id_ruta, id_parada_subida) y (id_ruta, id_parada_bajada) sea validada
      // atómicamente por PostgreSQL sin condiciones de carrera.
      return await this.assignmentRepository.createAssignment(input);
    } catch (error) {
      if (error instanceof CompositeStopRouteMismatchError) {
        throw new UnprocessableEntityException(error.message);
      }
      if (error instanceof DuplicateActiveAssignmentError) {
        throw new ConflictException(error.message);
      }
      if (error instanceof ForeignKeyReferenceError) {
        throw new BadRequestException(
          `Referencia inválida al asignar estudiante a ruta (${error.constraint}).`,
        );
      }
      throw error;
    }
  }

  async listAssignmentsByRoute(
    idRuta: string,
    soloActivas = true,
  ): Promise<RouteAssignmentRecord[]> {
    const route = await this.routeRepository.findRouteById(idRuta);
    if (!route) {
      throw new NotFoundException(`Ruta ${idRuta} no encontrada.`);
    }
    return this.assignmentRepository.listAssignmentsByRoute(
      idRuta,
      soloActivas,
    );
  }

  async listAssignmentsByStudent(
    idEstudiante: string,
    soloActivas = true,
  ): Promise<RouteAssignmentRecord[]> {
    return this.assignmentRepository.listAssignmentsByStudent(
      idEstudiante,
      soloActivas,
    );
  }

  async deactivateAssignment(
    idRuta: string,
    idAsignacion: string,
  ): Promise<void> {
    const assignment =
      await this.assignmentRepository.findAssignmentById(idAsignacion);
    if (!assignment || assignment.id_ruta !== idRuta) {
      throw new NotFoundException(
        `Asignación ${idAsignacion} no encontrada en la ruta ${idRuta}.`,
      );
    }

    const deactivated =
      await this.assignmentRepository.deactivateAssignment(idAsignacion);
    if (!deactivated) {
      throw new ConflictException(
        `La asignación ${idAsignacion} ya se encontraba inactiva.`,
      );
    }
  }
}
