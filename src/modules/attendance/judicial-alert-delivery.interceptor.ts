import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import {
  ActiveJudicialAlertMatch,
  InvalidJudicialAlertDocumentError,
  JudicialProtectionEngineError,
} from "../custody/judicial-alerts/domain/judicial-alert.types";
import { JudicialAlertsService } from "../custody/judicial-alerts/judicial-alerts.service";
import { BoardingNotificationQueueService } from "./boarding-notification-queue.service";
import { DeliveryValidationService } from "./delivery-validation.service";
import {
  ATTENDANCE_REPOSITORY,
  IAttendanceRepository,
} from "./domain/attendance-repository.port";
import {
  DeliveryInterceptor,
  DeliveryInterceptorContext,
} from "./domain/delivery-interceptor.interface";
import {
  JudicialAlertBlockedError,
  ReceptorType,
  StudentReceptorDirectory,
} from "./domain/disembark.types";
import { IncidentLogger } from "./incident-logger.service";

/**
 * Interceptor OCP de máxima prioridad (`priority = 1`) encargado de ejecutar el motor
 * de protección preventiva contra alertas judiciales activas en el desembarque (Issue #10).
 *
 * Garantías:
 * 1. Cotejo determinista mediante `documento_restringido_hash` (HMAC-SHA256) sobre
 *    el documento único normalizado (mitigación de falsos positivos por homonimia).
 * 2. Bloqueo categórico (`ALERTA_JUDICIAL_BLOQUEANTE`) antes de cualquier validación
 *    de acudiente/autorizado o mutación de aforo/custodia (el niño permanece en el bus).
 * 3. Generación automática de acta `CRITICO` en `incidente`, despacho de SMS de emergencia
 *    (`ALERTA_JUDICIAL_ACTIVADA`) a los acudientes NO restringidos (ej. madre), alerta en
 *    tiempo real a Coordinación y activación de alerta institucional a la Policía de
 *    Infancia y Adolescencia.
 * 4. Principio Fail-Safe: ante cualquier fallo técnico del motor judicial, bloquea la
 *    entrega y deja evidencia auditable.
 */
@Injectable()
export class JudicialAlertDeliveryInterceptor implements DeliveryInterceptor {
  readonly name = "JudicialAlertDeliveryInterceptor";
  readonly priority = 1;

  private readonly logger = new Logger(JudicialAlertDeliveryInterceptor.name);

  constructor(
    @Inject(ATTENDANCE_REPOSITORY)
    private readonly attendanceRepository: IAttendanceRepository,
    private readonly deliveryValidationService: DeliveryValidationService,
    private readonly incidentLogger: IncidentLogger,
    private readonly notificationQueue: BoardingNotificationQueueService,
    @Optional() private readonly judicialAlertsService?: JudicialAlertsService,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  async intercept(context: DeliveryInterceptorContext): Promise<void> {
    const hasDocumentEvidence = Boolean(
      context.documento_receptor?.trim() ||
        context.documento_blind_index?.trim(),
    );

    // Entrega matutina directa a sede educativa sin documento humano: no aplica restricción personal
    if (
      context.tipo_receptor === ReceptorType.SEDE_EDUCATIVA &&
      !hasDocumentEvidence
    ) {
      return;
    }

    let blindIndex: string | null = null;
    try {
      blindIndex = this.deliveryValidationService.resolveBlindIndex(
        context.documento_receptor,
        context.documento_blind_index,
      );
    } catch (error) {
      if (error instanceof InvalidJudicialAlertDocumentError) {
        return;
      }
      await this.recordFailSafeEngineError(context, error);
      throw new JudicialProtectionEngineError(
        context.id_estudiante,
        error instanceof Error ? error.message : String(error),
      );
    }

    // Si falta documento o no coincide con el blind index, delegar rechazo fail-safe a DeliveryValidationService
    if (!blindIndex) {
      return;
    }

    let directory: StudentReceptorDirectory | null = null;
    let activeMatch: ActiveJudicialAlertMatch | null = null;

    try {
      directory = await this.attendanceRepository.getStudentReceptorDirectory(
        context.id_estudiante,
      );

      if (this.judicialAlertsService) {
        activeMatch =
          await this.judicialAlertsService.findActiveRestrictionByHash(
            context.id_estudiante,
            blindIndex,
          );
      }

      if (!activeMatch && directory) {
        const repoAlert = directory.alertas_judiciales.find(
          (alert) =>
            alert.activa &&
            !alert.eliminado_soft &&
            alert.individuo_blind_index.toLowerCase() === blindIndex,
        );
        if (repoAlert) {
          activeMatch = {
            bloqueada: true,
            id_alerta: repoAlert.id_alerta,
            id_estudiante: repoAlert.id_estudiante,
            radicado_medida: repoAlert.radicado_medida,
            juzgado_emisor: "Autoridad Judicial Registrada",
            documento_restringido_hash: blindIndex,
            fecha_registro: new Date(),
          };
        }
      }
    } catch (error) {
      await this.recordFailSafeEngineError(context, error);
      if (error instanceof JudicialProtectionEngineError) {
        throw error;
      }
      throw new JudicialProtectionEngineError(
        context.id_estudiante,
        error instanceof Error ? error.message : String(error),
      );
    }

    if (!activeMatch) {
      return;
    }

    // Coincidencia de alerta judicial activa: activar protocolo completo de emergencia
    const now = context.now ?? new Date();
    const safeGuardianIds = (directory?.acudientes ?? [])
      .filter((g) => g.documento_blind_index.toLowerCase() !== blindIndex)
      .map((g) => g.id_acudiente);

    let persistedIncidentId: string | null = null;
    let persistedNotifPrincipalId: string | null = null;
    let persistedGuardianIds = safeGuardianIds;

    if (this.judicialAlertsService) {
      try {
        const persisted =
          await this.judicialAlertsService.recordEmergencyIncidentInStore({
            id_viaje: context.id_viaje,
            id_estudiante: context.id_estudiante,
            id_alerta: activeMatch.id_alerta,
            documento_restringido_hash: blindIndex,
            radicado_medida: activeMatch.radicado_medida,
            juzgado_emisor: activeMatch.juzgado_emisor,
            latitud: context.coordenadas_gps.latitud,
            longitud: context.coordenadas_gps.longitud,
            registrado_por_usuario: context.registrado_por_usuario,
          });

        if (persisted) {
          persistedIncidentId = persisted.id_incidente;
          persistedNotifPrincipalId = persisted.id_notificacion_principal;
          if (persisted.id_acudientes_notificados.length > 0) {
            persistedGuardianIds = persisted.id_acudientes_notificados;
          }
        }
      } catch (storeError) {
        // Nunca omitir el bloqueo aunque la persistencia auxiliar falle; continuamos con registro de contingencia
        this.logger.error(
          `[FAIL-SAFE] Error persistiendo protocolo judicial en BD: ${storeError instanceof Error ? storeError.message : String(storeError)}`,
        );
      }
    }

    const blockMessage = `ALERTA_JUDICIAL_BLOQUEANTE: Prohibida la entrega del menor '${context.id_estudiante}' bajo medida cautelar activa (radicado ${activeMatch.radicado_medida}, ${activeMatch.juzgado_emisor}). El menor permanece a bordo; protocolo de emergencia activado para Coordinación, acudiente no restringido y Policía de Infancia y Adolescencia.`;

    const incidentOutcome = await this.incidentLogger.logJudicialAlertIncident({
      id_incidente_existente: persistedIncidentId,
      id_alerta: activeMatch.id_alerta,
      id_viaje: context.id_viaje,
      id_ruta: context.id_ruta,
      id_estudiante: context.id_estudiante,
      radicado_medida: activeMatch.radicado_medida,
      juzgado_emisor: activeMatch.juzgado_emisor,
      tipo_receptor_intentado: context.tipo_receptor,
      mensaje: blockMessage,
      coordenadas: context.coordenadas_gps,
      registrado_por_usuario: context.registrado_por_usuario,
      notificaciones_sms_emergencia: persistedGuardianIds.length,
      alerta_policia_infancia_enviada: true,
      fecha_hora: now,
    });

    const emergencyDispatch =
      await this.notificationQueue.dispatchJudicialEmergencyAlerts({
        id_notificacion_principal_existente: persistedNotifPrincipalId,
        id_viaje: context.id_viaje,
        id_estudiante: context.id_estudiante,
        id_alerta: activeMatch.id_alerta,
        id_incidente: incidentOutcome.id_incidente,
        radicado_medida: activeMatch.radicado_medida,
        juzgado_emisor: activeMatch.juzgado_emisor,
        id_acudientes_seguros: persistedGuardianIds,
        coordenadas: context.coordenadas_gps,
        fecha_hora: now,
      });

    throw new JudicialAlertBlockedError(
      context.id_estudiante,
      activeMatch.radicado_medida,
      {
        idAlerta: activeMatch.id_alerta,
        idIncidente: incidentOutcome.id_incidente,
        juzgadoEmisor: activeMatch.juzgado_emisor,
        smsEmergenciaDespachados: emergencyDispatch.sms_encolados,
        alertaPoliciaEnviada: emergencyDispatch.alerta_policia_infancia_enviada,
        alreadyLogged: true,
      },
    );
  }

  private async recordFailSafeEngineError(
    context: DeliveryInterceptorContext,
    error: unknown,
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.error(
      `[FAIL-SAFE RNF-01] Fallo del motor de protección judicial para estudiante=${context.id_estudiante} viaje=${context.id_viaje}: ${reason}`,
    );

    try {
      await this.attendanceRepository.recordIncident({
        id_viaje: context.id_viaje,
        id_estudiante: context.id_estudiante,
        tipo_incidente: "ERROR_MOTOR_PROTECCION_JUDICIAL",
        severidad: "CRITICO",
        descripcion: `Bloqueo preventivo fail-safe (RNF-01): el motor de verificación judicial falló durante el desembarque (${reason}). El menor permanece a bordo.`,
        coordenadas: context.coordenadas_gps,
        registrado_por_usuario: context.registrado_por_usuario,
      });
    } catch {
      // Ya registrado en logger; no ocultar el error fail-safe original
    }

    if (this.auditService) {
      await this.auditService
        .logCriticalEvent({
          tipo_evento: "ERROR_MOTOR_PROTECCION_JUDICIAL",
          id_usuario: context.registrado_por_usuario ?? undefined,
          id_estudiante: context.id_estudiante,
          id_viaje: context.id_viaje,
          payload: {
            codigo: "MOTOR_JUDICIAL_NO_DISPONIBLE_BLOQUEO_SEGURO",
            motivo: reason,
            accion_tomada: "ENTREGA_BLOQUEADA_FAIL_SAFE",
          },
        })
        .catch(() => undefined);
    }
  }
}
