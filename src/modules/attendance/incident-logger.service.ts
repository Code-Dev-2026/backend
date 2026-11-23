import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
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
  BoardingResultCode,
  OvercapacityAlertEventPayload,
} from "./domain/attendance.types";

export interface LogOvercapacityIncidentInput {
  id_incidente_existente?: string | null;
  id_viaje: string;
  id_ruta: string;
  id_estudiante: string;
  total_a_bordo: number;
  capacidad_nominal: number;
  coordenadas: AttendanceCoordinates;
  registrado_por_usuario: string | null;
  fecha_hora: Date;
}

export interface LogDuplicateBoardingIncidentInput {
  id_incidente_existente?: string | null;
  id_viaje: string;
  id_estudiante: string;
  duplicado_por_idempotencia: boolean;
  coordenadas: AttendanceCoordinates;
  registrado_por_usuario: string | null;
}

export interface OvercapacityIncidentOutcome {
  id_incidente: string;
  alerta_coordinacion_emitida: boolean;
}

/**
 * Servicio SRP encargado de capturar anomalías operativas del abordaje QR
 * (sobrecupo RN-02 y doble abordaje RN-05), garantizar su persistencia en `incidente`,
 * registrar auditoría forense y emitir alertas en tiempo real a Coordinación (Issue #8).
 */
@Injectable()
export class IncidentLogger {
  private readonly logger = new Logger(IncidentLogger.name);

  constructor(
    @Inject(ATTENDANCE_REPOSITORY)
    private readonly repository: IAttendanceRepository,
    @Optional()
    @Inject(ATTENDANCE_REALTIME_PORT)
    private readonly realtimePort?: IAttendanceRealtimePort,
    @Optional()
    private readonly auditService?: AuditService,
  ) {}

  async logOvercapacityIncident(
    input: LogOvercapacityIncidentInput,
  ): Promise<OvercapacityIncidentOutcome> {
    let idIncidente = input.id_incidente_existente ?? null;

    if (!idIncidente) {
      const created = await this.repository.recordIncident({
        id_viaje: input.id_viaje,
        id_estudiante: input.id_estudiante,
        tipo_incidente: "INTENTO_SOBRECUPO",
        severidad: "CRITICO",
        descripcion: `Abordaje denegado por sobrecupo (RN-02): el vehículo alcanzó su capacidad homologada (${input.total_a_bordo}/${input.capacidad_nominal} pasajeros).`,
        coordenadas: input.coordenadas,
        registrado_por_usuario: input.registrado_por_usuario,
      });
      idIncidente = created.id_incidente;
    }

    if (this.auditService) {
      await this.auditService.logCriticalEvent({
        tipo_evento: "INTENTO_SOBRECUPO_DENEGADO",
        id_usuario: input.registrado_por_usuario ?? undefined,
        id_estudiante: input.id_estudiante,
        id_viaje: input.id_viaje,
        payload: {
          id_incidente: idIncidente,
          codigo: BoardingResultCode.DENEGADO_SOBRECUPO,
          total_a_bordo: input.total_a_bordo,
          capacidad_nominal: input.capacidad_nominal,
          severidad: "CRITICO",
        },
      });
    }

    const alertPayload: OvercapacityAlertEventPayload = {
      evento: "coordination:overcapacity_alert",
      codigo: BoardingResultCode.DENEGADO_SOBRECUPO,
      severidad: "CRITICO",
      id_incidente: idIncidente,
      id_viaje: input.id_viaje,
      id_ruta: input.id_ruta,
      id_estudiante: input.id_estudiante,
      total_a_bordo: input.total_a_bordo,
      capacidad_nominal: input.capacidad_nominal,
      registrado_por_usuario: input.registrado_por_usuario,
      coordenadas: input.coordenadas,
      mensaje: `ALERTA CRÍTICA DE SOBRECUPO (RN-02): intento de abordaje excediendo capacidad homologada (${input.total_a_bordo}/${input.capacidad_nominal}).`,
      fecha_hora: input.fecha_hora.toISOString(),
    };

    let alertaEmitida = false;
    if (this.realtimePort) {
      await this.realtimePort.emitOvercapacityAlert(alertPayload);
      alertaEmitida = true;
    }

    this.logger.warn(
      `[RN-02 SOBRECUPO] Viaje=${input.id_viaje} Incidente=${idIncidente} Aforo=${input.total_a_bordo}/${input.capacidad_nominal}`,
    );

    return {
      id_incidente: idIncidente,
      alerta_coordinacion_emitida: alertaEmitida,
    };
  }

  async logDuplicateBoardingIncident(
    input: LogDuplicateBoardingIncidentInput,
  ): Promise<string> {
    let idIncidente = input.id_incidente_existente ?? null;

    if (!idIncidente) {
      const created = await this.repository.recordIncident({
        id_viaje: input.id_viaje,
        id_estudiante: input.id_estudiante,
        tipo_incidente: "DOBLE_ABORDAJE_DETECTADO",
        severidad: "ADVERTENCIA",
        descripcion: input.duplicado_por_idempotencia
          ? `Reintento duplicado bloqueado por clave idempotente para estudiante ${input.id_estudiante} en viaje ${input.id_viaje} (RN-05).`
          : `Doble abordaje rechazado (RN-05): el estudiante ${input.id_estudiante} ya registra abordaje previo en el viaje ${input.id_viaje}.`,
        coordenadas: input.coordenadas,
        registrado_por_usuario: input.registrado_por_usuario,
      });
      idIncidente = created.id_incidente;
    }

    if (this.auditService) {
      await this.auditService.logCriticalEvent({
        tipo_evento: "DOBLE_ABORDAJE_RECHAZADO",
        id_usuario: input.registrado_por_usuario ?? undefined,
        id_estudiante: input.id_estudiante,
        id_viaje: input.id_viaje,
        payload: {
          id_incidente: idIncidente,
          codigo: BoardingResultCode.ABORDAJE_PREVIO_EXISTE,
          duplicado_por_idempotencia: input.duplicado_por_idempotencia,
          severidad: "ADVERTENCIA",
        },
      });
    }

    return idIncidente;
  }
}
