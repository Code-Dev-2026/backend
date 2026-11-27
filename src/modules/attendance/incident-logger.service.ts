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
import { FsmCustodyState } from "../custody/domain/custody.types";
import {
  AttendanceCoordinates,
  BoardingResultCode,
  IncidentSeverity,
  OvercapacityAlertEventPayload,
} from "./domain/attendance.types";
import {
  DisembarkResultCode,
  FailedDeliveryAlertEventPayload,
  JudicialAlertEventPayload,
  UnauthorizedReceptorAlertEventPayload,
} from "./domain/disembark.types";

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

export interface LogFailedDeliveryIncidentInput {
  id_incidente_existente?: string | null;
  id_entrega: string;
  id_viaje: string;
  id_ruta: string;
  id_estudiante: string;
  estado_custodia: FsmCustodyState;
  total_a_bordo: number;
  capacidad_nominal: number;
  observaciones: string;
  coordenadas: AttendanceCoordinates;
  registrado_por_usuario: string | null;
  fecha_hora: Date;
}

export interface LogUnauthorizedReceptorIncidentInput {
  id_viaje: string;
  id_estudiante: string;
  codigo: string;
  severidad: IncidentSeverity;
  tipo_receptor_intentado: string;
  mensaje: string;
  coordenadas: AttendanceCoordinates;
  registrado_por_usuario: string | null;
}

export interface LogJudicialAlertIncidentInput {
  id_incidente_existente?: string | null;
  id_alerta: string | null;
  id_viaje: string;
  id_ruta: string | null;
  id_estudiante: string;
  radicado_medida: string | null;
  juzgado_emisor: string | null;
  tipo_receptor_intentado: string;
  mensaje: string;
  coordenadas: AttendanceCoordinates;
  registrado_por_usuario: string | null;
  notificaciones_sms_emergencia: number;
  alerta_policia_infancia_enviada: boolean;
  fecha_hora: Date;
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

  async logFailedDeliveryIncident(
    input: LogFailedDeliveryIncidentInput,
  ): Promise<OvercapacityIncidentOutcome> {
    let idIncidente = input.id_incidente_existente ?? null;

    if (!idIncidente) {
      const created = await this.repository.recordIncident({
        id_viaje: input.id_viaje,
        id_estudiante: input.id_estudiante,
        tipo_incidente: "DESEMBARQUE_FALLIDO_RETORNO",
        severidad: "CRITICO",
        descripcion: input.observaciones,
        coordenadas: input.coordenadas,
        registrado_por_usuario: input.registrado_por_usuario,
      });
      idIncidente = created.id_incidente;
    }

    if (this.auditService) {
      await this.auditService.logCriticalEvent({
        tipo_evento: "DESEMBARQUE_FALLIDO_RETORNO_ACTIVADO",
        id_usuario: input.registrado_por_usuario ?? undefined,
        id_estudiante: input.id_estudiante,
        id_viaje: input.id_viaje,
        payload: {
          id_incidente: idIncidente,
          id_entrega: input.id_entrega,
          estado_custodia: input.estado_custodia,
          total_a_bordo: input.total_a_bordo,
          capacidad_nominal: input.capacidad_nominal,
          severidad: "CRITICO",
        },
      });
    }

    const alertPayload: FailedDeliveryAlertEventPayload = {
      evento: "coordination:failed_delivery_alert",
      codigo: DisembarkResultCode.DESEMBARQUE_FALLIDO_RETORNO,
      severidad: "CRITICO",
      id_incidente: idIncidente,
      id_entrega: input.id_entrega,
      id_viaje: input.id_viaje,
      id_ruta: input.id_ruta,
      id_estudiante: input.id_estudiante,
      estado_custodia: input.estado_custodia,
      total_a_bordo: input.total_a_bordo,
      capacidad_nominal: input.capacidad_nominal,
      observaciones: input.observaciones,
      registrado_por_usuario: input.registrado_por_usuario,
      coordenadas: input.coordenadas,
      fecha_hora: input.fecha_hora.toISOString(),
    };

    let alertaEmitida = false;
    if (this.realtimePort?.emitFailedDeliveryAlert) {
      await this.realtimePort.emitFailedDeliveryAlert(alertPayload);
      alertaEmitida = true;
    }

    this.logger.warn(
      `[RF-11 RETORNO SEDE] Viaje=${input.id_viaje} Estudiante=${input.id_estudiante} Incidente=${idIncidente} Aforo=${input.total_a_bordo}/${input.capacidad_nominal}`,
    );

    return {
      id_incidente: idIncidente,
      alerta_coordinacion_emitida: alertaEmitida,
    };
  }

  async logUnauthorizedReceptorIncident(
    input: LogUnauthorizedReceptorIncidentInput,
  ): Promise<OvercapacityIncidentOutcome> {
    const tipoIncidente =
      input.codigo === "ALERTA_JUDICIAL_BLOQUEANTE" ||
      input.codigo === "ALERTA_JUDICIAL_ACTIVA"
        ? "ALERTA_JUDICIAL_DETECTADA"
        : "INTENTO_ENTREGA_NO_AUTORIZADO";

    const created = await this.repository.recordIncident({
      id_viaje: input.id_viaje,
      id_estudiante: input.id_estudiante,
      tipo_incidente: tipoIncidente,
      severidad: input.severidad,
      descripcion: input.mensaje,
      coordenadas: input.coordenadas,
      registrado_por_usuario: input.registrado_por_usuario,
    });

    if (this.auditService) {
      await this.auditService.logCriticalEvent({
        tipo_evento: tipoIncidente,
        id_usuario: input.registrado_por_usuario ?? undefined,
        id_estudiante: input.id_estudiante,
        id_viaje: input.id_viaje,
        payload: {
          id_incidente: created.id_incidente,
          codigo: input.codigo,
          tipo_receptor_intentado: input.tipo_receptor_intentado,
          severidad: input.severidad,
        },
      });
    }

    let alertaEmitida = false;
    if (this.realtimePort?.emitUnauthorizedReceptorAlert) {
      const payload: UnauthorizedReceptorAlertEventPayload = {
        evento: "coordination:unauthorized_receptor_alert",
        codigo: input.codigo,
        severidad: input.severidad === "CRITICO" ? "CRITICO" : "ADVERTENCIA",
        id_incidente: created.id_incidente,
        id_viaje: input.id_viaje,
        id_estudiante: input.id_estudiante,
        tipo_receptor_intentado: input.tipo_receptor_intentado,
        mensaje: input.mensaje,
        registrado_por_usuario: input.registrado_por_usuario,
        coordenadas: input.coordenadas,
        fecha_hora: created.fecha_hora.toISOString(),
      };
      await this.realtimePort.emitUnauthorizedReceptorAlert(payload);
      alertaEmitida = true;
    }

    return {
      id_incidente: created.id_incidente,
      alerta_coordinacion_emitida: alertaEmitida,
    };
  }

  /**
   * Genera automáticamente el acta de incidente `CRITICO` en `incidente` ante
   * coincidencia de alerta judicial activa, registra auditoría forense y emite
   * alertas inmediatas a Coordinación (Issue #10).
   */
  async logJudicialAlertIncident(
    input: LogJudicialAlertIncidentInput,
  ): Promise<OvercapacityIncidentOutcome> {
    let idIncidente = input.id_incidente_existente ?? null;
    let fechaHora = input.fecha_hora;

    if (!idIncidente) {
      const created = await this.repository.recordIncident({
        id_viaje: input.id_viaje,
        id_estudiante: input.id_estudiante,
        tipo_incidente: "ALERTA_JUDICIAL_DETECTADA",
        severidad: "CRITICO",
        descripcion: input.mensaje,
        coordenadas: input.coordenadas,
        registrado_por_usuario: input.registrado_por_usuario,
      });
      idIncidente = created.id_incidente;
      fechaHora = created.fecha_hora;
    }

    if (this.auditService) {
      await this.auditService.logCriticalEvent({
        tipo_evento: "ALERTA_JUDICIAL_ACTIVADA",
        id_usuario: input.registrado_por_usuario ?? undefined,
        id_estudiante: input.id_estudiante,
        id_viaje: input.id_viaje,
        payload: {
          id_incidente: idIncidente,
          id_alerta: input.id_alerta,
          codigo: "ALERTA_JUDICIAL_BLOQUEANTE",
          radicado_medida: input.radicado_medida,
          juzgado_emisor: input.juzgado_emisor,
          tipo_receptor_intentado: input.tipo_receptor_intentado,
          menor_permanece_a_bordo: true,
          notificaciones_sms_emergencia: input.notificaciones_sms_emergencia,
          alerta_policia_infancia_enviada:
            input.alerta_policia_infancia_enviada,
          severidad: "CRITICO",
        },
      });
    }

    let alertaEmitida = false;
    if (this.realtimePort?.emitJudicialAlert) {
      const judicialPayload: JudicialAlertEventPayload = {
        evento: "coordination:judicial_alert",
        codigo: "ALERTA_JUDICIAL_BLOQUEANTE",
        tipo_notificacion: "ALERTA_JUDICIAL_ACTIVADA",
        severidad: "CRITICO",
        id_alerta: input.id_alerta,
        id_incidente: idIncidente,
        id_viaje: input.id_viaje,
        id_ruta: input.id_ruta,
        id_estudiante: input.id_estudiante,
        radicado_medida: input.radicado_medida,
        juzgado_emisor: input.juzgado_emisor,
        menor_permanece_a_bordo: true,
        notificaciones_sms_emergencia: input.notificaciones_sms_emergencia,
        alerta_policia_infancia_enviada: input.alerta_policia_infancia_enviada,
        registrado_por_usuario: input.registrado_por_usuario,
        coordenadas: input.coordenadas,
        mensaje: input.mensaje,
        fecha_hora: fechaHora.toISOString(),
      };
      await this.realtimePort.emitJudicialAlert(judicialPayload);
      alertaEmitida = true;
    }

    if (this.realtimePort?.emitUnauthorizedReceptorAlert) {
      const compatPayload: UnauthorizedReceptorAlertEventPayload = {
        evento: "coordination:unauthorized_receptor_alert",
        codigo: "ALERTA_JUDICIAL_BLOQUEANTE",
        severidad: "CRITICO",
        id_incidente: idIncidente,
        id_viaje: input.id_viaje,
        id_estudiante: input.id_estudiante,
        tipo_receptor_intentado: input.tipo_receptor_intentado,
        mensaje: input.mensaje,
        registrado_por_usuario: input.registrado_por_usuario,
        coordenadas: input.coordenadas,
        fecha_hora: fechaHora.toISOString(),
      };
      await this.realtimePort.emitUnauthorizedReceptorAlert(compatPayload);
      alertaEmitida = true;
    }

    this.logger.warn(
      `[ALERTA_JUDICIAL_BLOQUEANTE] Viaje=${input.id_viaje} Estudiante=${input.id_estudiante} Incidente=${idIncidente} Radicado=${input.radicado_medida ?? "N/A"}`,
    );

    return {
      id_incidente: idIncidente,
      alerta_coordinacion_emitida: alertaEmitida,
    };
  }
}
