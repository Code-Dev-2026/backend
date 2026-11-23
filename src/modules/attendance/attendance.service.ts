import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from "@nestjs/common";
import { CustodyStateEnum } from "@common/enums/custody-state.enum";
import { BoardingNotificationQueueService } from "./boarding-notification-queue.service";
import { CapacityEnforcer } from "./capacity-enforcer.service";
import {
  ATTENDANCE_REALTIME_PORT,
  IAttendanceRealtimePort,
} from "./domain/attendance-realtime.port";
import {
  ATTENDANCE_REPOSITORY,
  IAttendanceRepository,
} from "./domain/attendance-repository.port";
import {
  AttendanceCoordinates,
  BoardingResponse,
  BoardingResultCode,
  BoardingValidationMethod,
  InvalidAttendanceCoordinatesError,
  InvalidQrTokenError,
  StudentNotAssignedToRouteError,
  TripNotFoundError,
  TripNotInProgressError,
} from "./domain/attendance.types";
import { IncidentLogger } from "./incident-logger.service";
import { InMemoryAttendanceRepository } from "./infrastructure/in-memory-attendance.repository";
import { QrTokenValidator } from "./qr-token-validator.service";

export interface BoardingScanInput {
  id_viaje: string;
  qr_token: string;
  coordenadas_gps: AttendanceCoordinates;
  id_parada?: string;
  metodo_validacion?: BoardingValidationMethod;
  sincronizado_offline?: boolean;
  idempotency_key?: string | null;
  registrado_por_usuario?: string | null;
}

/**
 * Servicio coordinador SRP de abordaje QR atómico y control concurrente de sobrecupo (Issue #8).
 *
 * - Valida QR estático/dinámico mediante `QrTokenValidator`.
 * - Delega el control transaccional atómico al repositorio (`fn_registrar_abordaje_atomico` en PostgreSQL
 *   o mutex por viaje + `CapacityEnforcer` en memoria).
 * - Delega el registro de anomalías operativas y alertas a Coordinación a `IncidentLogger`.
 * - Emite el evento en tiempo real `student:boarded` vía Socket.IO (`IAttendanceRealtimePort`).
 * - Encola de forma no bloqueante la notificación push hacia el acudiente titular.
 */
@Injectable()
export class AttendanceService {
  private readonly repository: IAttendanceRepository;
  private readonly qrValidator: QrTokenValidator;
  private readonly capacityEnforcer: CapacityEnforcer;
  private readonly incidentLogger: IncidentLogger;
  private readonly notificationQueue: BoardingNotificationQueueService;

  constructor(
    @Optional()
    @Inject(ATTENDANCE_REPOSITORY)
    repository?: IAttendanceRepository,
    @Optional() qrValidator?: QrTokenValidator,
    @Optional() capacityEnforcer?: CapacityEnforcer,
    @Optional() incidentLogger?: IncidentLogger,
    @Optional()
    @Inject(ATTENDANCE_REALTIME_PORT)
    private readonly realtimePort?: IAttendanceRealtimePort,
    @Optional() notificationQueue?: BoardingNotificationQueueService,
  ) {
    this.capacityEnforcer = capacityEnforcer ?? new CapacityEnforcer();
    this.repository =
      repository ?? new InMemoryAttendanceRepository(this.capacityEnforcer);
    this.qrValidator = qrValidator ?? new QrTokenValidator();
    this.incidentLogger =
      incidentLogger ??
      new IncidentLogger(this.repository, this.realtimePort);
    this.notificationQueue =
      notificationQueue ?? new BoardingNotificationQueueService();
  }

  /**
   * Registro atómico de abordaje QR con control estricto de aforo (RF-08, RN-02, RN-05, ASVS V11.1).
   *
   * Retorna respuesta JSON estructurada no fatal para:
   * - `ABORDAJE_EXITOSO`
   * - `DENEGADO_SOBRECUPO` (sin incrementar contador, registrando incidente y alertando a Coordinación)
   * - `ABORDAJE_PREVIO_EXISTE` (sin incrementar contador, registrando incidente de doble escaneo)
   */
  async registerBoarding(input: BoardingScanInput): Promise<BoardingResponse> {
    const startedAt = Date.now();

    try {
      const validatedQr = this.qrValidator.validate(
        input.qr_token,
        input.metodo_validacion ?? "QR_INSTITUCIONAL",
      );

      const atomicResult = await this.repository.registerAtomicBoarding({
        id_viaje: input.id_viaje,
        id_estudiante: validatedQr.id_estudiante,
        qr_token_hash: validatedQr.qr_token_hash,
        metodo_validacion: validatedQr.metodo_validacion,
        coordenadas: input.coordenadas_gps,
        registrado_por_usuario: input.registrado_por_usuario ?? null,
        idempotency_key: input.idempotency_key ?? null,
        sincronizado_offline: input.sincronizado_offline ?? false,
      });

      // Defensa adicional en capa de servicio: validar invariante de capacidad reportada
      this.capacityEnforcer.assertValidCapacityBounds(
        atomicResult.total_a_bordo,
        atomicResult.capacidad_nominal,
      );

      const cuposDisponibles = Math.max(
        0,
        atomicResult.capacidad_nominal - atomicResult.total_a_bordo,
      );

      if (atomicResult.codigo === BoardingResultCode.DENEGADO_SOBRECUPO) {
        const incidentOutcome =
          await this.incidentLogger.logOvercapacityIncident({
            id_incidente_existente: atomicResult.id_incidente,
            id_viaje: atomicResult.id_viaje,
            id_ruta: atomicResult.id_ruta,
            id_estudiante: atomicResult.id_estudiante,
            total_a_bordo: atomicResult.total_a_bordo,
            capacidad_nominal: atomicResult.capacidad_nominal,
            coordenadas: input.coordenadas_gps,
            registrado_por_usuario: input.registrado_por_usuario ?? null,
            fecha_hora: atomicResult.fecha_hora,
          });

        return {
          aprobado: false,
          codigo: BoardingResultCode.DENEGADO_SOBRECUPO,
          mensaje: atomicResult.mensaje,
          id_viaje: atomicResult.id_viaje,
          id_ruta: atomicResult.id_ruta,
          id_estudiante: atomicResult.id_estudiante,
          id_asistencia: null,
          id_incidente: incidentOutcome.id_incidente,
          estado_custodia: atomicResult.estado_custodia,
          metodo_validacion: atomicResult.metodo_validacion,
          total_a_bordo: atomicResult.total_a_bordo,
          capacidad_nominal: atomicResult.capacidad_nominal,
          cupos_disponibles: cuposDisponibles,
          duplicado_por_idempotencia: false,
          evento_realtime_emitido: null,
          alerta_coordinacion_emitida:
            incidentOutcome.alerta_coordinacion_emitida,
          notificacion_acudiente_encolada: false,
          id_notificacion: null,
          latencia_ms: Date.now() - startedAt,
          fecha_hora: atomicResult.fecha_hora.toISOString(),
        };
      }

      if (atomicResult.codigo === BoardingResultCode.ABORDAJE_PREVIO_EXISTE) {
        const idIncidente =
          await this.incidentLogger.logDuplicateBoardingIncident({
            id_incidente_existente: atomicResult.id_incidente,
            id_viaje: atomicResult.id_viaje,
            id_estudiante: atomicResult.id_estudiante,
            duplicado_por_idempotencia: atomicResult.duplicado_por_idempotencia,
            coordenadas: input.coordenadas_gps,
            registrado_por_usuario: input.registrado_por_usuario ?? null,
          });

        return {
          aprobado: false,
          codigo: BoardingResultCode.ABORDAJE_PREVIO_EXISTE,
          mensaje: atomicResult.mensaje,
          id_viaje: atomicResult.id_viaje,
          id_ruta: atomicResult.id_ruta,
          id_estudiante: atomicResult.id_estudiante,
          id_asistencia: atomicResult.id_asistencia,
          id_incidente: idIncidente,
          estado_custodia: atomicResult.estado_custodia,
          metodo_validacion: atomicResult.metodo_validacion,
          total_a_bordo: atomicResult.total_a_bordo,
          capacidad_nominal: atomicResult.capacidad_nominal,
          cupos_disponibles: cuposDisponibles,
          duplicado_por_idempotencia: atomicResult.duplicado_por_idempotencia,
          evento_realtime_emitido: null,
          alerta_coordinacion_emitida: false,
          notificacion_acudiente_encolada: false,
          id_notificacion: null,
          latencia_ms: Date.now() - startedAt,
          fecha_hora: atomicResult.fecha_hora.toISOString(),
        };
      }

      // ABORDAJE_EXITOSO: emitir evento WebSocket `student:boarded` y encolar push al acudiente titular
      let realtimeEventEmitted: string | null = null;
      if (this.realtimePort && atomicResult.id_asistencia) {
        await this.realtimePort.emitStudentBoarded({
          evento: "student:boarded",
          id_viaje: atomicResult.id_viaje,
          id_ruta: atomicResult.id_ruta,
          id_estudiante: atomicResult.id_estudiante,
          id_asistencia: atomicResult.id_asistencia,
          estado_custodia: atomicResult.estado_custodia,
          metodo_validacion: atomicResult.metodo_validacion,
          total_a_bordo: atomicResult.total_a_bordo,
          capacidad_nominal: atomicResult.capacidad_nominal,
          registrado_por_usuario: input.registrado_por_usuario ?? null,
          coordenadas: input.coordenadas_gps,
          fecha_hora: atomicResult.fecha_hora.toISOString(),
        });
        realtimeEventEmitted = "student:boarded";
      }

      const queuedPush = atomicResult.id_asistencia
        ? this.notificationQueue.enqueueGuardianBoardingNotification({
            id_notificacion_existente: atomicResult.id_notificacion,
            id_viaje: atomicResult.id_viaje,
            id_estudiante: atomicResult.id_estudiante,
            id_acudiente_titular: atomicResult.id_acudiente_titular,
            id_asistencia: atomicResult.id_asistencia,
            total_a_bordo: atomicResult.total_a_bordo,
            capacidad_nominal: atomicResult.capacidad_nominal,
            fecha_hora: atomicResult.fecha_hora,
          })
        : { encolada: false, id_notificacion: null };

      return {
        aprobado: true,
        codigo: BoardingResultCode.ABORDAJE_EXITOSO,
        mensaje: atomicResult.mensaje,
        id_viaje: atomicResult.id_viaje,
        id_ruta: atomicResult.id_ruta,
        id_estudiante: atomicResult.id_estudiante,
        id_asistencia: atomicResult.id_asistencia,
        id_incidente: null,
        estado_custodia: atomicResult.estado_custodia,
        metodo_validacion: atomicResult.metodo_validacion,
        total_a_bordo: atomicResult.total_a_bordo,
        capacidad_nominal: atomicResult.capacidad_nominal,
        cupos_disponibles: cuposDisponibles,
        duplicado_por_idempotencia: false,
        evento_realtime_emitido: realtimeEventEmitted,
        alerta_coordinacion_emitida: false,
        notificacion_acudiente_encolada: queuedPush.encolada,
        id_notificacion: queuedPush.id_notificacion,
        latencia_ms: Date.now() - startedAt,
        fecha_hora: atomicResult.fecha_hora.toISOString(),
      };
    } catch (error) {
      this.rethrowAsHttpException(error);
    }
  }

  /**
   * Placeholder heredado de descenso (fuera de alcance del Issue #8; corresponde al Issue #9).
   */
  async registerAlighting(id_viaje: string, id_estudiante: string) {
    return {
      estado_custodia: CustodyStateEnum.ENTREGADO_A_TUTOR,
      id_viaje,
      id_estudiante,
      hora_descenso: new Date().toISOString(),
    };
  }

  private rethrowAsHttpException(error: unknown): never {
    if (error instanceof TripNotFoundError) {
      throw new NotFoundException({
        code: error.code,
        message: error.message,
      });
    }

    if (error instanceof TripNotInProgressError) {
      throw new ConflictException({
        code: error.code,
        message: error.message,
        id_viaje: error.idViaje,
        estado_actual: error.currentState,
      });
    }

    if (error instanceof InvalidQrTokenError) {
      throw new UnprocessableEntityException({
        code: error.code,
        message: error.message,
      });
    }

    if (error instanceof StudentNotAssignedToRouteError) {
      throw new UnprocessableEntityException({
        code: error.code,
        message: error.message,
        id_estudiante: error.idEstudiante,
        id_viaje: error.idViaje,
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
