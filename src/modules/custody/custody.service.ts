import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from "@nestjs/common";
import { CustodyStateEnum } from "@common/enums/custody-state.enum";
import {
  CustodyTransitionContext,
  CustodyTripDirection,
  ICustodyFsmPort,
} from "@common/ports/custody-fsm.port";
import { CustodyTransitionValidatorService } from "./custody-transition-validator.service";
import {
  CUSTODY_REPOSITORY,
  ICustodyRepository,
  PersistCustodyTransitionResult,
} from "./domain/custody-repository.port";
import {
  CustodyChainVerificationReport,
  CustodyEnrollmentNotFoundError,
  CustodyHistoryRecord,
  CustodyInvariantViolationError,
  FsmCustodyState,
  InvalidCustodyCoordinatesError,
  MorningInitializationSummary,
  StudentTripCustodyRecord,
  TripClosureBlockedError,
  TripCustodyMeta,
  TripDirection,
  WormImmutabilityViolationError,
  isFsmCustodyState,
  isTripDirection,
} from "./domain/custody.types";
import { InMemoryCustodyRepository } from "./infrastructure/in-memory-custody.repository";
import { MorningCustodyInitJob } from "./morning-custody-init.job";

export interface ExecuteCustodyTransitionInput {
  id_viaje: string;
  id_estudiante: string;
  estado_destino: FsmCustodyState;
  tipo_recorrido: TripDirection;
  disparador_evento?: string;
  registrado_por_usuario?: string | null;
  latitud?: number;
  longitud?: number;
}

export interface StudentTripCustodyDetail extends StudentTripCustodyRecord {
  transiciones_permitidas_manana: FsmCustodyState[];
  transiciones_permitidas_tarde: FsmCustodyState[];
}

@Injectable()
export class CustodyService implements ICustodyFsmPort {
  private readonly repository: ICustodyRepository;
  private readonly validator: CustodyTransitionValidatorService;
  private readonly morningJob: MorningCustodyInitJob;

  constructor(
    @Optional()
    @Inject(CUSTODY_REPOSITORY)
    repository?: ICustodyRepository,
    @Optional()
    validator?: CustodyTransitionValidatorService,
    @Optional()
    morningJob?: MorningCustodyInitJob,
  ) {
    this.repository = repository ?? new InMemoryCustodyRepository();
    this.validator = validator ?? new CustodyTransitionValidatorService();
    this.morningJob = morningJob ?? new MorningCustodyInitJob(this.repository);
  }

  // --------------------------------------------------------------------------
  // PUERTO ICustodyFsmPort (ADR-001 / Issue #7)
  // --------------------------------------------------------------------------

  canTransition(
    from: CustodyStateEnum,
    to: CustodyStateEnum,
    tipo_recorrido?: CustodyTripDirection,
  ): boolean {
    if (!isFsmCustodyState(from) || !isFsmCustodyState(to)) {
      return false;
    }

    if (tipo_recorrido) {
      if (!isTripDirection(tipo_recorrido)) {
        return false;
      }
      return this.validator.isTransitionAllowed(from, to, tipo_recorrido);
    }

    return (
      this.validator.isTransitionAllowed(from, to, TripDirection.MANANA) ||
      this.validator.isTransitionAllowed(from, to, TripDirection.TARDE)
    );
  }

  async transition(
    context: CustodyTransitionContext,
  ): Promise<{ success: boolean; newState: CustodyStateEnum }> {
    if (
      !isFsmCustodyState(context.estado_origen) ||
      !isFsmCustodyState(context.estado_destino)
    ) {
      throw new UnprocessableEntityException({
        code: "CUSTODY_FSM_INVARIANT_VIOLATION",
        message: `Estado de custodia fuera del dominio FSM: '${context.estado_origen}' -> '${context.estado_destino}'.`,
      });
    }

    const direction =
      context.tipo_recorrido === "TARDE"
        ? TripDirection.TARDE
        : TripDirection.MANANA;

    const existing = await this.repository.getStudentTripState(
      context.id_viaje,
      context.id_estudiante,
    );

    if (!existing) {
      await this.repository.enrollStudentInTrip(
        context.id_viaje,
        context.id_estudiante,
        context.estado_origen,
      );
    }

    const result = await this.executeTransition({
      id_viaje: context.id_viaje,
      id_estudiante: context.id_estudiante,
      estado_destino: context.estado_destino,
      tipo_recorrido: direction,
      disparador_evento: context.disparador_evento,
      registrado_por_usuario: context.id_monitora,
      latitud: context.latitud,
      longitud: context.longitud,
    });

    return {
      success: true,
      newState: result.custody.estado_custodia as unknown as CustodyStateEnum,
    };
  }

  // --------------------------------------------------------------------------
  // ORQUESTACIÓN DE CICLO DE CUSTODIA FSM + WORM (Issue #7)
  // --------------------------------------------------------------------------

  async enrollStudentInTrip(
    idViaje: string,
    idEstudiante: string,
    esPasajeroOcasional = false,
  ): Promise<StudentTripCustodyRecord> {
    return this.repository.enrollStudentInTrip(
      idViaje,
      idEstudiante,
      FsmCustodyState.NO_INICIADO,
      esPasajeroOcasional,
    );
  }

  async executeTransition(
    input: ExecuteCustodyTransitionInput,
  ): Promise<PersistCustodyTransitionResult> {
    const current = await this.repository.getStudentTripState(
      input.id_viaje,
      input.id_estudiante,
    );

    if (!current) {
      throw new NotFoundException(
        new CustodyEnrollmentNotFoundError(input.id_viaje, input.id_estudiante)
          .message,
      );
    }

    try {
      const { outcome, coordenadas } = this.validator.validateTransition({
        currentState: current.estado_custodia,
        targetState: input.estado_destino,
        tripDirection: input.tipo_recorrido,
        disparador_evento: input.disparador_evento,
        latitud: input.latitud,
        longitud: input.longitud,
      });

      return await this.repository.applyTransitionAndAppendHistory({
        id_viaje: input.id_viaje,
        id_estudiante: input.id_estudiante,
        estado_destino: outcome.toState,
        tipo_recorrido: outcome.tripDirection,
        disparador_evento: outcome.disparador_evento,
        registrado_por_usuario: input.registrado_por_usuario ?? null,
        coordenadas,
      });
    } catch (error) {
      this.rethrowAsHttpException(error);
    }
  }

  async getStudentTripCustody(
    idViaje: string,
    idEstudiante: string,
  ): Promise<StudentTripCustodyDetail> {
    const record = await this.repository.getStudentTripState(
      idViaje,
      idEstudiante,
    );

    if (!record) {
      throw new NotFoundException(
        new CustodyEnrollmentNotFoundError(idViaje, idEstudiante).message,
      );
    }

    return {
      ...record,
      transiciones_permitidas_manana: this.validator.getAllowedNextStates(
        record.estado_custodia,
        TripDirection.MANANA,
      ),
      transiciones_permitidas_tarde: this.validator.getAllowedNextStates(
        record.estado_custodia,
        TripDirection.TARDE,
      ),
    };
  }

  async listTripCustody(idViaje: string): Promise<StudentTripCustodyRecord[]> {
    return this.repository.listTripCustodyStates(idViaje);
  }

  async getTripCustodyHistory(
    idViaje: string,
  ): Promise<CustodyHistoryRecord[]> {
    return this.repository.listHistoryByTrip(idViaje);
  }

  async getStudentCustodyHistory(
    idEstudiante: string,
    limit?: number,
  ): Promise<CustodyHistoryRecord[]> {
    return this.repository.listHistoryByStudent(idEstudiante, limit);
  }

  async verifyWormChainIntegrity(
    limit?: number,
  ): Promise<CustodyChainVerificationReport> {
    return this.repository.verifyHistoryIntegrity(limit);
  }

  async runMorningInitialization(
    fecha?: string,
  ): Promise<MorningInitializationSummary> {
    return this.morningJob.runForDate(fecha);
  }

  /**
   * Mitigación de riesgo (Issue #7): bloquea el cierre del viaje (`FINALIZADO`)
   * si aún existen menores en estado `A_BORDO_VEHICULO`.
   */
  async assertTripCanFinalize(idViaje: string): Promise<void> {
    const studentsOnBoard = await this.repository.listStudentsByState(
      idViaje,
      FsmCustodyState.A_BORDO_VEHICULO,
    );

    if (studentsOnBoard.length > 0) {
      const err = new TripClosureBlockedError(
        idViaje,
        studentsOnBoard.length,
        studentsOnBoard.map((s) => s.id_estudiante),
      );
      throw new ConflictException({
        code: err.code,
        message: err.message,
        id_viaje: idViaje,
        estudiantes_a_bordo: err.studentIds,
        total_a_bordo: err.studentsOnBoardCount,
      });
    }
  }

  async finalizeTrip(idViaje: string): Promise<TripCustodyMeta> {
    await this.assertTripCanFinalize(idViaje);
    try {
      return await this.repository.finalizeTrip(idViaje);
    } catch (error) {
      this.rethrowAsHttpException(error);
    }
  }

  // --------------------------------------------------------------------------
  // MÉTODOS HEREDADOS (compatibilidad hasta implementación de Issue #9)
  // --------------------------------------------------------------------------

  /**
   * Verificar legitimación del receptor en parada (RF-06, RN-04)
   * Valida si existe alerta judicial de restricción cautelar activa
   */
  async verifyReceptor(id_estudiante: string, documento_receptor: string) {
    const hasRestriction = documento_receptor === "RESTRINGIDO_123";
    if (hasRestriction) {
      throw new ForbiddenException(
        "ALERTA JUDICIAL ACTIVA: Prohibida entrega del menor a esta persona bajo orden judicial cautelar.",
      );
    }

    return {
      autorizado: true,
      tipo_receptor: "ADULTO_AUTORIZADO",
      nombre: "Abuela Materna (Elena Restrepo)",
      prioridad: 1,
      alerta_judicial_activa: false,
    };
  }

  /**
   * Disparo del protocolo de Desembarque Fallido y Retorno Seguro a Sede (RF-08)
   */
  async triggerFailedDeliveryProtocol(
    id_estudiante: string,
    motivo: string,
    id_viaje: string,
  ) {
    return {
      id_estudiante,
      id_viaje,
      nuevo_estado: CustodyStateEnum.DESEMBARQUE_FALLIDO,
      accion: "RETORNO_SEGURO_SEDE",
      motivo,
      custodia_a_cargo: "MONITORA_EN_RUTA",
      destino_final:
        "Sede Colegio San Benito del Otún - Coordinación de Convivencia",
      alerta_inmediata_coordinacion: true,
      timestamp: new Date().toISOString(),
    };
  }

  private rethrowAsHttpException(error: unknown): never {
    if (error instanceof CustodyInvariantViolationError) {
      throw new UnprocessableEntityException({
        code: error.code,
        message: error.message,
        estado_origen: error.fromState,
        estado_destino: error.toState,
        tipo_recorrido: error.tripDirection,
        destinos_permitidos: error.allowedTargets,
      });
    }

    if (error instanceof TripClosureBlockedError) {
      throw new ConflictException({
        code: error.code,
        message: error.message,
        id_viaje: error.idViaje,
        total_a_bordo: error.studentsOnBoardCount,
        estudiantes_a_bordo: error.studentIds,
      });
    }

    if (error instanceof CustodyEnrollmentNotFoundError) {
      throw new NotFoundException({
        code: error.code,
        message: error.message,
      });
    }

    if (error instanceof InvalidCustodyCoordinatesError) {
      throw new BadRequestException({
        code: error.code,
        message: error.message,
      });
    }

    if (error instanceof WormImmutabilityViolationError) {
      throw new ForbiddenException({
        code: error.code,
        message: error.message,
      });
    }

    throw error;
  }
}
