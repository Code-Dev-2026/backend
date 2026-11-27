import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from "@nestjs/common";
import * as crypto from "crypto";
import { HashService } from "@common/crypto/hash.service";
import { AuditService } from "../audit/audit.service";
import {
  IOccasionalPassengerRepository,
  OCCASIONAL_PASSENGER_REPOSITORY,
} from "./domain/occasional-passenger-repository.port";
import {
  AbsenceIrreversibleError,
  ApproveOccasionalSeatResult,
  CoordinatorNotAuthorizedForTripError,
  DuplicateOccasionalRequestError,
  GuardianNotAuthorizedForStudentError,
  OccasionalBookingRulesViolationError,
  OccasionalPassengerRecord,
  OccasionalRequestInvalidStateError,
  OccasionalRequestNotFoundError,
  OccasionalStudentNotFoundError,
  OccasionalTransactionError,
  OccasionalTripNotFoundError,
  OccasionalTripNotScheduledError,
  RequestOccasionalSeatResult,
  StudentAlreadyAssignedToRouteError,
  TripManifestEntry,
  VacancyBalanceSnapshot,
} from "./domain/occasional-passenger.types";
import { InMemoryOccasionalPassengerRepository } from "./infrastructure/in-memory-occasional-passenger.repository";
import { PassengerCapacityEvaluator } from "./passenger-capacity-evaluator.service";

export const PASSENGERS_CLOCK = Symbol("PASSENGERS_CLOCK");
export type ClockProvider = () => Date;

export interface RequestOccasionalBookingInput {
  id_viaje: string;
  id_estudiante: string;
  solicitado_por_usuario: string;
  motivo?: string | null;
}

export interface ApproveOccasionalBookingInput {
  id_pasajero_ocasional: string;
  aprobado_por_usuario: string;
  id_coordinador?: string | null;
}

export interface RequestOccasionalBookingResponse {
  id_pasajero_ocasional: string;
  id_estudiante: string;
  id_viaje: string;
  id_ruta: string;
  id_estudiante_que_libera_cupo: string;
  estado_solicitud: string;
  solicitado_en: string;
  hora_inicio_programada: string;
  motivo: string | null;
  qr_provisional_token: string;
  qr_provisional_hash: string;
  balance_vacantes: {
    capacidad_nominal: number;
    estudiantes_asignados: number;
    inasistencias_reportadas: number;
    ocasionales_activos: number;
    ocupacion_proyectada: number;
    inasistencias_disponibles: number;
    cupo_nominal_disponible: number;
    vacantes_netas: number;
  };
  mensaje: string;
}

export interface ApproveOccasionalBookingResponse {
  id_pasajero_ocasional: string;
  id_estudiante: string;
  id_viaje: string;
  id_ruta: string;
  id_estudiante_que_libera_cupo: string;
  estado_solicitud: string;
  solicitado_en: string;
  aprobado_en: string;
  aprobado_por_coordinador: string;
  qr_provisional_hash: string;
  lista_asistencia: TripManifestEntry;
  balance_vacantes: {
    capacidad_nominal: number;
    estudiantes_asignados: number;
    inasistencias_reportadas: number;
    ocasionales_activos: number;
    ocupacion_proyectada: number;
    inasistencias_disponibles: number;
    cupo_nominal_disponible: number;
    vacantes_netas: number;
  };
  mensaje: string;
}

/**
 * Servicio SRP encargado exclusivamente del ciclo de vida de reservas de pasajeros
 * ocasionales (RF-05, RN-03, OWASP ASVS V4.1):
 * - Radicación por el acudiente (validando vínculo acudiente-estudiante, antelación >= 2h
 *   y reserva atómica de una vacante liberada por inasistencia).
 * - Aprobación por Coordinación con inclusión transaccional automática en `viaje_estudiante`.
 * - Cumplimiento de irreversibilidad de inasistencia cuando el cupo ya fue asignado.
 */
@Injectable()
export class OccasionalBookingService {
  private readonly repository: IOccasionalPassengerRepository;
  private readonly capacityEvaluator: PassengerCapacityEvaluator;
  private readonly hashService: HashService;
  private readonly now: ClockProvider;

  constructor(
    @Optional()
    @Inject(OCCASIONAL_PASSENGER_REPOSITORY)
    repository?: IOccasionalPassengerRepository,
    @Optional() capacityEvaluator?: PassengerCapacityEvaluator,
    @Optional() hashService?: HashService,
    @Optional() private readonly auditService?: AuditService,
    @Optional()
    @Inject(PASSENGERS_CLOCK)
    clock?: ClockProvider,
  ) {
    this.capacityEvaluator =
      capacityEvaluator ?? new PassengerCapacityEvaluator();
    this.repository =
      repository ??
      new InMemoryOccasionalPassengerRepository(this.capacityEvaluator);
    this.hashService = hashService ?? new HashService();
    this.now = clock ?? (() => new Date());
  }

  async requestOccasionalSeat(
    input: RequestOccasionalBookingInput,
  ): Promise<RequestOccasionalBookingResponse> {
    const requestedAt = this.now();
    const provisionalToken = `CS-OCASIONAL-${crypto.randomBytes(16).toString("hex")}`;
    const provisionalHash = this.hashService.sha256(provisionalToken);

    try {
      const result: RequestOccasionalSeatResult =
        await this.repository.requestOccasionalSeat({
          id_viaje: input.id_viaje,
          id_estudiante: input.id_estudiante,
          solicitado_por_usuario: input.solicitado_por_usuario,
          qr_provisional_hash: provisionalHash,
          motivo: input.motivo ?? null,
          solicitado_en: requestedAt,
        });

      await this.auditService?.logCriticalEvent({
        tipo_evento: "PASAJERO_OCASIONAL_SOLICITADO",
        id_usuario: input.solicitado_por_usuario,
        id_estudiante: result.solicitud.id_estudiante,
        id_viaje: result.solicitud.id_viaje,
        payload: {
          id_pasajero_ocasional: result.solicitud.id_pasajero_ocasional,
          id_estudiante_que_libera_cupo:
            result.solicitud.id_estudiante_que_libera_cupo,
          estado_solicitud: result.solicitud.estado_solicitud,
          vacantes_netas_restantes: result.balance_vacantes.vacantes_netas,
        },
      });

      return {
        id_pasajero_ocasional: result.solicitud.id_pasajero_ocasional,
        id_estudiante: result.solicitud.id_estudiante,
        id_viaje: result.solicitud.id_viaje,
        id_ruta: result.solicitud.id_ruta,
        id_estudiante_que_libera_cupo:
          result.solicitud.id_estudiante_que_libera_cupo,
        estado_solicitud: result.solicitud.estado_solicitud,
        solicitado_en: result.solicitud.solicitado_en.toISOString(),
        hora_inicio_programada: result.hora_inicio_programada.toISOString(),
        motivo: result.solicitud.motivo,
        qr_provisional_token: provisionalToken,
        qr_provisional_hash: result.solicitud.qr_provisional_hash,
        balance_vacantes: this.formatBalance(result.balance_vacantes),
        mensaje:
          "Solicitud de pasajero ocasional radicada con cupo reservado por inasistencia. Pendiente de aprobación por Coordinación.",
      };
    } catch (error) {
      throw this.mapDomainErrorToHttp(error);
    }
  }

  async approveOccasionalSeat(
    input: ApproveOccasionalBookingInput,
  ): Promise<ApproveOccasionalBookingResponse> {
    try {
      const result: ApproveOccasionalSeatResult =
        await this.repository.approveOccasionalSeat({
          id_pasajero_ocasional: input.id_pasajero_ocasional,
          aprobado_por_usuario: input.aprobado_por_usuario,
          id_coordinador: input.id_coordinador ?? null,
        });

      await this.auditService?.logCriticalEvent({
        tipo_evento: "PASAJERO_OCASIONAL_APROBADO",
        id_usuario: input.aprobado_por_usuario,
        id_estudiante: result.solicitud.id_estudiante,
        id_viaje: result.solicitud.id_viaje,
        payload: {
          id_pasajero_ocasional: result.solicitud.id_pasajero_ocasional,
          id_estudiante_que_libera_cupo:
            result.solicitud.id_estudiante_que_libera_cupo,
          aprobado_por_coordinador: result.solicitud.aprobado_por_coordinador,
          estado_custodia: result.lista_asistencia.estado_custodia,
          es_pasajero_ocasional: result.lista_asistencia.es_pasajero_ocasional,
        },
      });

      return {
        id_pasajero_ocasional: result.solicitud.id_pasajero_ocasional,
        id_estudiante: result.solicitud.id_estudiante,
        id_viaje: result.solicitud.id_viaje,
        id_ruta: result.solicitud.id_ruta,
        id_estudiante_que_libera_cupo:
          result.solicitud.id_estudiante_que_libera_cupo,
        estado_solicitud: result.solicitud.estado_solicitud,
        solicitado_en: result.solicitud.solicitado_en.toISOString(),
        aprobado_en: (result.solicitud.aprobado_en ?? this.now()).toISOString(),
        aprobado_por_coordinador:
          result.solicitud.aprobado_por_coordinador ?? "",
        qr_provisional_hash: result.solicitud.qr_provisional_hash,
        lista_asistencia: result.lista_asistencia,
        balance_vacantes: this.formatBalance(result.balance_vacantes),
        mensaje:
          "Solicitud aprobada por Coordinación. El estudiante fue incluido automáticamente en la lista de asistencia del viaje (viaje_estudiante).",
      };
    } catch (error) {
      throw this.mapDomainErrorToHttp(error);
    }
  }

  async getTripVacancyBalance(idViaje: string): Promise<VacancyBalanceSnapshot> {
    try {
      return await this.repository.evaluateTripVacancyBalance(idViaje);
    } catch (error) {
      throw this.mapDomainErrorToHttp(error);
    }
  }

  async revertAbsence(idViaje: string, idEstudiante: string): Promise<void> {
    try {
      await this.repository.revertAbsence(idViaje, idEstudiante);
    } catch (error) {
      throw this.mapDomainErrorToHttp(error);
    }
  }

  async findRequestById(
    idPasajeroOcasional: string,
  ): Promise<OccasionalPassengerRecord | null> {
    return this.repository.findRequestById(idPasajeroOcasional);
  }

  async listTripPassengerManifest(
    idViaje: string,
  ): Promise<TripManifestEntry[]> {
    return this.repository.listTripPassengerManifest(idViaje);
  }

  private formatBalance(balance: VacancyBalanceSnapshot) {
    return {
      capacidad_nominal: balance.capacidad_nominal,
      estudiantes_asignados: balance.estudiantes_asignados,
      inasistencias_reportadas: balance.inasistencias_reportadas,
      ocasionales_activos: balance.ocasionales_activos,
      ocupacion_proyectada: balance.ocupacion_proyectada,
      inasistencias_disponibles: balance.inasistencias_disponibles,
      cupo_nominal_disponible: balance.cupo_nominal_disponible,
      vacantes_netas: balance.vacantes_netas,
    };
  }

  private mapDomainErrorToHttp(error: unknown): Error {
    if (
      error instanceof OccasionalTripNotFoundError ||
      error instanceof OccasionalStudentNotFoundError ||
      error instanceof OccasionalRequestNotFoundError
    ) {
      return new NotFoundException({
        code: error.code,
        message: error.message,
      });
    }

    if (
      error instanceof GuardianNotAuthorizedForStudentError ||
      error instanceof CoordinatorNotAuthorizedForTripError
    ) {
      return new ForbiddenException({
        code: error.code,
        message: error.message,
      });
    }

    if (
      error instanceof OccasionalTripNotScheduledError ||
      error instanceof StudentAlreadyAssignedToRouteError ||
      error instanceof DuplicateOccasionalRequestError ||
      error instanceof OccasionalRequestInvalidStateError ||
      error instanceof AbsenceIrreversibleError
    ) {
      return new ConflictException({
        code: error.code,
        message: error.message,
      });
    }

    if (error instanceof OccasionalBookingRulesViolationError) {
      return new UnprocessableEntityException({
        code: error.code,
        motivos_rechazo: error.motivos_rechazo,
        ...(error.detalle_antelacion
          ? {
              detalle_antelacion: {
                cumple_antelacion: error.detalle_antelacion.cumple_antelacion,
                minutos_antelacion: error.detalle_antelacion.minutos_antelacion,
                horas_antelacion: error.detalle_antelacion.horas_antelacion,
                minimo_horas_requerido:
                  error.detalle_antelacion.minimo_horas_requerido,
                hora_inicio_programada:
                  error.detalle_antelacion.hora_inicio_programada.toISOString(),
                solicitado_en:
                  error.detalle_antelacion.solicitado_en.toISOString(),
                hora_limite_solicitud:
                  error.detalle_antelacion.hora_limite_solicitud.toISOString(),
              },
            }
          : {}),
        ...(error.balance_vacantes
          ? { balance_vacantes: this.formatBalance(error.balance_vacantes) }
          : {}),
        message: error.message,
      });
    }

    if (error instanceof OccasionalTransactionError) {
      return new InternalServerErrorException({
        code: error.code,
        message: error.message,
      });
    }

    return error instanceof Error
      ? error
      : new InternalServerErrorException(String(error));
  }
}
