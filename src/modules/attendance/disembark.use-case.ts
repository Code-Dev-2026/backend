import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { JudicialProtectionEngineError } from "../custody/judicial-alerts/domain/judicial-alert.types";
import { BoardingNotificationQueueService } from "./boarding-notification-queue.service";
import { DeliveryValidationService } from "./delivery-validation.service";
import {
  ATTENDANCE_REALTIME_PORT,
  IAttendanceRealtimePort,
} from "./domain/attendance-realtime.port";
import {
  ATTENDANCE_REPOSITORY,
  IAttendanceRepository,
} from "./domain/attendance-repository.port";
import { DeliveryInterceptorChain } from "./domain/delivery-interceptor.interface";
import {
  AttendanceCoordinates,
  BoardingValidationMethod,
  InvalidAttendanceCoordinatesError,
  TripNotFoundError,
  TripNotInProgressError,
} from "./domain/attendance.types";
import {
  AuthorizationExpiredError,
  AuthorizedAdultsLimitExceededError,
  CoordinatorUnauthorizedError,
  DisembarkOutcomeType,
  DisembarkResponse,
  DisembarkResultCode,
  DuplicateDisembarkError,
  FailedDeliveryRecordNotFoundError,
  FinalizeSchoolCustodyResponse,
  IncompatibleTripDirectionError,
  JudicialAlertBlockedError,
  ReceptorInactiveOrRevokedError,
  ReceptorType,
  ReceptorUnauthorizedError,
  SchoolCustodyAlreadyFinalizedError,
  StudentNotFoundError,
  StudentNotInSchoolReturnError,
  StudentNotOnBoardError,
} from "./domain/disembark.types";
import { IncidentLogger } from "./incident-logger.service";
import { JudicialAlertDeliveryInterceptor } from "./judicial-alert-delivery.interceptor";

export interface RegisterDisembarkInput {
  id_viaje: string;
  id_estudiante: string;
  resultado_entrega?: DisembarkOutcomeType;
  tipo_receptor?: ReceptorType | null;
  documento_receptor?: string | null;
  documento_blind_index?: string | null;
  id_receptor?: string | null;
  metodo_validacion?: BoardingValidationMethod;
  coordenadas_gps: AttendanceCoordinates;
  foto_evidencia_url?: string | null;
  observaciones_fallido?: string | null;
  sincronizado_offline?: boolean;
  idempotency_key?: string | null;
  registrado_por_usuario?: string | null;
}

export interface FinalizeSchoolCustodyInput {
  id_viaje: string;
  id_estudiante: string;
  recibido_por_coordinador: string;
  coordenadas_gps: AttendanceCoordinates;
  observaciones?: string | null;
  idempotency_key?: string | null;
  registrado_por_usuario?: string | null;
}

/**
 * Caso de uso SRP responsable de ejecutar el cambio de estado de custodia durante
 * el desembarque seguro, el protocolo de no-entrega con retorno a sede escolar
 * y el cierre formal de custodia en sede (Issue #9: RF-09, RF-11, RN-04, ASVS V4.1).
 *
 * Delega exclusivamente la potestad del receptor a `DeliveryValidationService`.
 */
@Injectable()
export class DisembarkUseCase {
  private readonly deliveryInterceptorChain: DeliveryInterceptorChain;

  constructor(
    @Inject(ATTENDANCE_REPOSITORY)
    private readonly repository: IAttendanceRepository,
    private readonly deliveryValidationService: DeliveryValidationService,
    private readonly incidentLogger: IncidentLogger,
    private readonly notificationQueue: BoardingNotificationQueueService,
    @Optional()
    @Inject(ATTENDANCE_REALTIME_PORT)
    private readonly realtimePort?: IAttendanceRealtimePort,
    @Optional()
    deliveryInterceptorChain?: DeliveryInterceptorChain,
  ) {
    this.deliveryInterceptorChain =
      deliveryInterceptorChain ??
      new DeliveryInterceptorChain([
        new JudicialAlertDeliveryInterceptor(
          this.repository,
          this.deliveryValidationService,
          this.incidentLogger,
          this.notificationQueue,
        ),
      ]);
  }

  /**
   * Ejecuta el desembarque seguro de un único estudiante (`POST /asistencia/descenso`).
   *
   * - Si `resultado_entrega === ENTREGADO_EXITOSO`: valida el receptor vía `DeliveryValidationService`,
   *   libera 1 cupo en `viaje.total_a_bordo`, registra una fila independiente en `entrega` y `registro_de_asistencia`,
   *   transiciona la FSM (WORM SHA-256) y encola notificaciones de entrega exitosa.
   * - Si `resultado_entrega === DESEMBARQUE_FALLIDO_RETORNO`: mantiene `total_a_bordo` SIN decrementar,
   *   transiciona la FSM a `RETORNO_SEDE_POR_FALLA_ENTREGA`, crea incidente CRITICO y alerta de inmediato
   *   a los acudientes y a la Coordinación.
   */
  async executeDisembark(
    input: RegisterDisembarkInput,
  ): Promise<DisembarkResponse> {
    const startedAt = Date.now();
    const resultado =
      input.resultado_entrega ?? DisembarkOutcomeType.ENTREGADO_EXITOSO;

    try {
      this.assertValidCoordinates(input.coordenadas_gps);

      const tripOccupancy = await this.repository.getTripOccupancy(
        input.id_viaje,
      );
      if (!tripOccupancy) {
        throw new TripNotFoundError(input.id_viaje);
      }
      if (tripOccupancy.estado !== "EN_CURSO") {
        throw new TripNotInProgressError(input.id_viaje, tripOccupancy.estado);
      }

      const tripDirection = await this.repository.getTripDirection(
        input.id_viaje,
      );
      if (!tripDirection) {
        throw new TripNotFoundError(input.id_viaje);
      }

      let validatedBlindIndex: string | null = null;
      let validatedReceptorId: string | null = input.id_receptor ?? null;
      let validatedReceptorType: ReceptorType | null = null;

      if (resultado === DisembarkOutcomeType.ENTREGADO_EXITOSO) {
        if (!input.tipo_receptor) {
          throw new BadRequestException({
            code: "TIPO_RECEPTOR_REQUERIDO",
            message:
              "El campo tipo_receptor (ACUDIENTE, ADULTO_AUTORIZADO o SEDE_EDUCATIVA) es obligatorio para entrega exitosa.",
          });
        }

        try {
          // Cadena OCP de interceptores cautelares (Issue #10: motor judicial con prioridad absoluta)
          await this.deliveryInterceptorChain.execute({
            id_viaje: input.id_viaje,
            id_ruta: tripOccupancy.id_ruta,
            id_estudiante: input.id_estudiante,
            tipo_receptor: input.tipo_receptor,
            documento_receptor: input.documento_receptor,
            documento_blind_index: input.documento_blind_index,
            id_receptor: input.id_receptor,
            tipo_recorrido: tripDirection,
            coordenadas_gps: input.coordenadas_gps,
            registrado_por_usuario: input.registrado_por_usuario ?? null,
          });

          const validation =
            await this.deliveryValidationService.validateReceptorForDelivery({
              id_estudiante: input.id_estudiante,
              tipo_receptor: input.tipo_receptor,
              documento_receptor: input.documento_receptor,
              documento_blind_index: input.documento_blind_index,
              id_receptor: input.id_receptor,
              tipo_recorrido: tripDirection,
            });

          validatedReceptorType = validation.tipo_receptor;
          validatedBlindIndex = validation.documento_blind_index;
          validatedReceptorId =
            validation.id_acudiente ?? validation.id_autorizado ?? null;
        } catch (validationError) {
          if (
            this.isReceptorSecurityDenial(validationError) &&
            !(
              validationError instanceof JudicialAlertBlockedError &&
              validationError.alreadyLogged
            )
          ) {
            await this.incidentLogger.logUnauthorizedReceptorIncident({
              id_viaje: input.id_viaje,
              id_estudiante: input.id_estudiante,
              codigo: validationError.code,
              severidad:
                validationError instanceof JudicialAlertBlockedError
                  ? "CRITICO"
                  : "ADVERTENCIA",
              tipo_receptor_intentado: input.tipo_receptor,
              mensaje: validationError.message,
              coordenadas: input.coordenadas_gps,
              registrado_por_usuario: input.registrado_por_usuario ?? null,
            });
          }
          throw validationError;
        }
      }

      const atomic = await this.repository.registerAtomicDisembark({
        id_viaje: input.id_viaje,
        id_estudiante: input.id_estudiante,
        resultado_entrega: resultado,
        tipo_receptor: validatedReceptorType,
        receptor_documento_blind_index: validatedBlindIndex,
        id_receptor: validatedReceptorId,
        metodo_validacion:
          input.metodo_validacion ?? "VERIFICACION_VISUAL_PARADA",
        coordenadas: input.coordenadas_gps,
        registrado_por_usuario: input.registrado_por_usuario ?? null,
        foto_evidencia_url: input.foto_evidencia_url ?? null,
        observaciones_fallido: input.observaciones_fallido ?? null,
        idempotency_key: input.idempotency_key ?? null,
        sincronizado_offline: input.sincronizado_offline ?? false,
      });

      const cuposDisponibles = Math.max(
        0,
        atomic.capacidad_nominal - atomic.total_a_bordo,
      );

      // Si es respuesta idempotente repetida, no duplicar alertas ni notificaciones
      if (atomic.duplicado_por_idempotencia) {
        return {
          aprobado: atomic.aprobado,
          codigo: atomic.codigo,
          mensaje: atomic.mensaje,
          id_viaje: atomic.id_viaje,
          id_ruta: atomic.id_ruta,
          id_estudiante: atomic.id_estudiante,
          id_entrega: atomic.id_entrega,
          id_asistencia: atomic.id_asistencia,
          id_incidente: atomic.id_incidente,
          tipo_receptor: atomic.tipo_receptor,
          id_acudiente_receptor: atomic.id_acudiente_receptor,
          id_autorizado_receptor: atomic.id_autorizado_receptor,
          estado_entrega: atomic.estado_entrega,
          estado_custodia: atomic.estado_custodia,
          metodo_validacion: atomic.metodo_validacion,
          total_a_bordo: atomic.total_a_bordo,
          capacidad_nominal: atomic.capacidad_nominal,
          cupos_disponibles: cuposDisponibles,
          duplicado_por_idempotencia: true,
          evento_realtime_emitido: null,
          alerta_coordinacion_emitida: false,
          notificaciones_acudientes_encoladas: 0,
          id_notificacion_principal: atomic.id_notificacion_principal,
          latencia_ms: Date.now() - startedAt,
          fecha_hora: atomic.fecha_hora.toISOString(),
        };
      }

      if (atomic.codigo === DisembarkResultCode.DESEMBARQUE_FALLIDO_RETORNO) {
        const incidentOutcome =
          await this.incidentLogger.logFailedDeliveryIncident({
            id_incidente_existente: atomic.id_incidente,
            id_entrega: atomic.id_entrega,
            id_viaje: atomic.id_viaje,
            id_ruta: atomic.id_ruta,
            id_estudiante: atomic.id_estudiante,
            estado_custodia: atomic.estado_custodia,
            total_a_bordo: atomic.total_a_bordo,
            capacidad_nominal: atomic.capacidad_nominal,
            observaciones:
              input.observaciones_fallido?.trim() ||
              "Ningún adulto autorizado compareció en la parada; retorno seguro a sede escolar activado.",
            coordenadas: input.coordenadas_gps,
            registrado_por_usuario: input.registrado_por_usuario ?? null,
            fecha_hora: atomic.fecha_hora,
          });

        const queuedAlerts =
          this.notificationQueue.enqueueFailedDeliveryAlerts({
            id_notificacion_principal_existente:
              atomic.id_notificacion_principal,
            id_viaje: atomic.id_viaje,
            id_entrega: atomic.id_entrega,
            id_incidente: incidentOutcome.id_incidente,
            id_estudiante: atomic.id_estudiante,
            id_acudientes: atomic.id_acudientes_notificados,
            total_a_bordo: atomic.total_a_bordo,
            fecha_hora: atomic.fecha_hora,
          });

        return {
          aprobado: false,
          codigo: DisembarkResultCode.DESEMBARQUE_FALLIDO_RETORNO,
          mensaje: atomic.mensaje,
          id_viaje: atomic.id_viaje,
          id_ruta: atomic.id_ruta,
          id_estudiante: atomic.id_estudiante,
          id_entrega: atomic.id_entrega,
          id_asistencia: null,
          id_incidente: incidentOutcome.id_incidente,
          tipo_receptor: atomic.tipo_receptor,
          id_acudiente_receptor: null,
          id_autorizado_receptor: null,
          estado_entrega: atomic.estado_entrega,
          estado_custodia: atomic.estado_custodia,
          metodo_validacion: atomic.metodo_validacion,
          total_a_bordo: atomic.total_a_bordo,
          capacidad_nominal: atomic.capacidad_nominal,
          cupos_disponibles: cuposDisponibles,
          duplicado_por_idempotencia: false,
          evento_realtime_emitido: incidentOutcome.alerta_coordinacion_emitida
            ? "coordination:failed_delivery_alert"
            : null,
          alerta_coordinacion_emitida:
            incidentOutcome.alerta_coordinacion_emitida,
          notificaciones_acudientes_encoladas: queuedAlerts.encoladas,
          id_notificacion_principal: queuedAlerts.id_notificacion_principal,
          latencia_ms: Date.now() - startedAt,
          fecha_hora: atomic.fecha_hora.toISOString(),
        };
      }

      // DESCENSO_EXITOSO: emitir evento WebSocket y encolar notificaciones push a los acudientes
      let realtimeEventEmitted: string | null = null;
      if (this.realtimePort?.emitStudentDisembarked && atomic.id_asistencia) {
        await this.realtimePort.emitStudentDisembarked({
          evento: "student:disembarked",
          id_viaje: atomic.id_viaje,
          id_ruta: atomic.id_ruta,
          id_estudiante: atomic.id_estudiante,
          id_entrega: atomic.id_entrega,
          id_asistencia: atomic.id_asistencia,
          tipo_receptor: atomic.tipo_receptor,
          estado_custodia: atomic.estado_custodia,
          total_a_bordo: atomic.total_a_bordo,
          capacidad_nominal: atomic.capacidad_nominal,
          registrado_por_usuario: input.registrado_por_usuario ?? null,
          coordenadas: input.coordenadas_gps,
          fecha_hora: atomic.fecha_hora.toISOString(),
        });
        realtimeEventEmitted = "student:disembarked";
      }

      const queuedPush =
        this.notificationQueue.enqueueGuardianDisembarkNotification({
          id_notificacion_principal_existente: atomic.id_notificacion_principal,
          id_viaje: atomic.id_viaje,
          id_entrega: atomic.id_entrega,
          id_asistencia: atomic.id_asistencia ?? atomic.id_entrega,
          id_estudiante: atomic.id_estudiante,
          id_acudientes: atomic.id_acudientes_notificados,
          tipo_receptor: atomic.tipo_receptor,
          estado_custodia: atomic.estado_custodia,
          total_a_bordo: atomic.total_a_bordo,
          capacidad_nominal: atomic.capacidad_nominal,
          fecha_hora: atomic.fecha_hora,
        });

      return {
        aprobado: true,
        codigo: DisembarkResultCode.DESCENSO_EXITOSO,
        mensaje: atomic.mensaje,
        id_viaje: atomic.id_viaje,
        id_ruta: atomic.id_ruta,
        id_estudiante: atomic.id_estudiante,
        id_entrega: atomic.id_entrega,
        id_asistencia: atomic.id_asistencia,
        id_incidente: null,
        tipo_receptor: atomic.tipo_receptor,
        id_acudiente_receptor: atomic.id_acudiente_receptor,
        id_autorizado_receptor: atomic.id_autorizado_receptor,
        estado_entrega: atomic.estado_entrega,
        estado_custodia: atomic.estado_custodia,
        metodo_validacion: atomic.metodo_validacion,
        total_a_bordo: atomic.total_a_bordo,
        capacidad_nominal: atomic.capacidad_nominal,
        cupos_disponibles: cuposDisponibles,
        duplicado_por_idempotencia: false,
        evento_realtime_emitido: realtimeEventEmitted,
        alerta_coordinacion_emitida: false,
        notificaciones_acudientes_encoladas: queuedPush.encoladas,
        id_notificacion_principal: queuedPush.id_notificacion_principal,
        latencia_ms: Date.now() - startedAt,
        fecha_hora: atomic.fecha_hora.toISOString(),
      };
    } catch (error) {
      this.rethrowAsHttpException(error);
    }
  }

  /**
   * Cierra formalmente la custodia de un estudiante retornado a la sede escolar
   * (`POST /asistencia/custodia/finalizar-sede`).
   *
   * - Valida la autoridad del coordinador del colegio mediante `DeliveryValidationService`.
   * - Libera el cupo `total_a_bordo - 1` ÚNICAMENTE al emitir el `acta_custodia` firmada SHA-256.
   * - Transiciona `RETORNO_SEDE_POR_FALLA_ENTREGA -> EN_COLEGIO` en la FSM WORM SHA-256.
   * - Notifica a los acudientes y emite evento en tiempo real.
   */
  async finalizeSchoolCustody(
    input: FinalizeSchoolCustodyInput,
  ): Promise<FinalizeSchoolCustodyResponse> {
    const startedAt = Date.now();

    try {
      this.assertValidCoordinates(input.coordenadas_gps);

      await this.deliveryValidationService.validateSchoolCoordinator({
        id_estudiante: input.id_estudiante,
        id_coordinador: input.recibido_por_coordinador,
      });

      const finalized = await this.repository.finalizeSchoolCustody({
        id_viaje: input.id_viaje,
        id_estudiante: input.id_estudiante,
        recibido_por_coordinador: input.recibido_por_coordinador,
        coordenadas: input.coordenadas_gps,
        registrado_por_usuario: input.registrado_por_usuario ?? null,
        observaciones: input.observaciones ?? null,
        idempotency_key: input.idempotency_key ?? null,
      });

      let realtimeEventEmitted: string | null = null;
      if (this.realtimePort?.emitSchoolCustodyFinalized) {
        await this.realtimePort.emitSchoolCustodyFinalized({
          evento: "custody:school_return_completed",
          id_viaje: finalized.id_viaje,
          id_ruta: finalized.id_ruta,
          id_estudiante: finalized.id_estudiante,
          id_entrega: finalized.id_entrega,
          id_acta: finalized.id_acta,
          recibido_por_coordinador: finalized.recibido_por_coordinador,
          firma_digital_hash: finalized.firma_digital_hash,
          estado_custodia: finalized.estado_custodia,
          total_a_bordo: finalized.total_a_bordo,
          capacidad_nominal: finalized.capacidad_nominal,
          fecha_recepcion: finalized.fecha_recepcion.toISOString(),
        });
        realtimeEventEmitted = "custody:school_return_completed";
      }

      const queuedPush =
        this.notificationQueue.enqueueSchoolReturnFinalizedAlerts({
          id_notificacion_principal_existente:
            finalized.id_notificacion_principal,
          id_viaje: finalized.id_viaje,
          id_entrega: finalized.id_entrega,
          id_acta: finalized.id_acta,
          id_estudiante: finalized.id_estudiante,
          id_acudientes: finalized.id_acudientes_notificados,
          recibido_por_coordinador: finalized.recibido_por_coordinador,
          total_a_bordo: finalized.total_a_bordo,
          fecha_recepcion: finalized.fecha_recepcion,
        });

      return {
        finalizado: finalized.finalizado,
        codigo: finalized.codigo,
        mensaje: finalized.mensaje,
        id_viaje: finalized.id_viaje,
        id_ruta: finalized.id_ruta,
        id_estudiante: finalized.id_estudiante,
        id_entrega: finalized.id_entrega,
        id_acta: finalized.id_acta,
        id_asistencia: finalized.id_asistencia,
        recibido_por_coordinador: finalized.recibido_por_coordinador,
        firma_digital_hash: finalized.firma_digital_hash,
        estado_custodia: finalized.estado_custodia,
        total_a_bordo: finalized.total_a_bordo,
        capacidad_nominal: finalized.capacidad_nominal,
        cupos_disponibles: Math.max(
          0,
          finalized.capacidad_nominal - finalized.total_a_bordo,
        ),
        evento_realtime_emitido: realtimeEventEmitted,
        notificaciones_acudientes_encoladas: queuedPush.encoladas,
        id_notificacion_principal: queuedPush.id_notificacion_principal,
        latencia_ms: Date.now() - startedAt,
        fecha_recepcion: finalized.fecha_recepcion.toISOString(),
      };
    } catch (error) {
      this.rethrowAsHttpException(error);
    }
  }

  private assertValidCoordinates(coords: AttendanceCoordinates): void {
    if (
      !coords ||
      !Number.isFinite(coords.latitud) ||
      !Number.isFinite(coords.longitud) ||
      coords.latitud < -90 ||
      coords.latitud > 90 ||
      coords.longitud < -180 ||
      coords.longitud > 180
    ) {
      throw new InvalidAttendanceCoordinatesError(
        `Coordenadas WGS84 inválidas: (${coords?.latitud}, ${coords?.longitud}).`,
      );
    }
  }

  private isReceptorSecurityDenial(
    error: unknown,
  ): error is
    | JudicialAlertBlockedError
    | ReceptorUnauthorizedError
    | AuthorizationExpiredError
    | ReceptorInactiveOrRevokedError {
    return (
      error instanceof JudicialAlertBlockedError ||
      error instanceof ReceptorUnauthorizedError ||
      error instanceof AuthorizationExpiredError ||
      error instanceof ReceptorInactiveOrRevokedError
    );
  }

  private rethrowAsHttpException(error: unknown): never {
    if (
      error instanceof TripNotFoundError ||
      error instanceof StudentNotFoundError
    ) {
      throw new NotFoundException({
        code: error.code,
        message: error.message,
      });
    }

    if (error instanceof JudicialAlertBlockedError) {
      throw new ForbiddenException({
        code: error.code,
        error: error.code,
        message: error.message,
        id_alerta: error.idAlerta,
        id_incidente: error.idIncidente,
        radicado_medida: error.radicado ?? null,
        juzgado_emisor: error.juzgadoEmisor,
        menor_permanece_a_bordo: true,
        notificaciones_sms_emergencia: error.smsEmergenciaDespachados,
        alerta_policia_infancia_enviada: error.alertaPoliciaEnviada,
      });
    }

    if (error instanceof JudicialProtectionEngineError) {
      throw new ServiceUnavailableException({
        code: error.code,
        error: error.code,
        message: error.message,
        menor_permanece_a_bordo: true,
      });
    }

    if (
      error instanceof ReceptorUnauthorizedError ||
      error instanceof AuthorizationExpiredError ||
      error instanceof ReceptorInactiveOrRevokedError ||
      error instanceof CoordinatorUnauthorizedError
    ) {
      throw new ForbiddenException({
        code: error.code,
        message: error.message,
      });
    }

    if (
      error instanceof TripNotInProgressError ||
      error instanceof FailedDeliveryRecordNotFoundError ||
      error instanceof SchoolCustodyAlreadyFinalizedError ||
      error instanceof DuplicateDisembarkError
    ) {
      throw new ConflictException({
        code: error.code,
        message: error.message,
      });
    }

    if (
      error instanceof StudentNotOnBoardError ||
      error instanceof StudentNotInSchoolReturnError ||
      error instanceof IncompatibleTripDirectionError ||
      error instanceof AuthorizedAdultsLimitExceededError
    ) {
      throw new UnprocessableEntityException({
        code: error.code,
        message: error.message,
      });
    }

    if (error instanceof InvalidAttendanceCoordinatesError) {
      throw new BadRequestException({
        code: error.code,
        message: error.message,
      });
    }

    throw error;
  }
}
