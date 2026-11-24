import { Injectable, Logger, Optional } from "@nestjs/common";
import { uuidv7 } from "@common/utils/uuidv7";
import { NotificationsService } from "../notifications/notifications.service";

export interface EnqueueBoardingPushInput {
  id_notificacion_existente?: string | null;
  id_viaje: string;
  id_estudiante: string;
  id_acudiente_titular: string | null;
  id_asistencia: string;
  total_a_bordo: number;
  capacidad_nominal: number;
  fecha_hora: Date;
}

export interface QueuedBoardingNotification {
  id_notificacion: string;
  idempotency_key: string;
  id_viaje: string;
  id_estudiante: string;
  id_acudiente: string;
  tipo_evento?:
    | "ABORDAJE_EXITOSO"
    | "DESCENSO_EXITOSO"
    | "INCIDENTE_ENTREGA"
    | "RECEPCION_SEDE";
  estado: "ENCOLADA" | "DESPACHADA" | "FALLIDA";
  encolada_en: string;
}

export interface EnqueueDisembarkPushInput {
  id_notificacion_principal_existente?: string | null;
  id_viaje: string;
  id_entrega: string;
  id_asistencia: string;
  id_estudiante: string;
  id_acudientes: string[];
  tipo_receptor: string;
  estado_custodia: string;
  total_a_bordo: number;
  capacidad_nominal: number;
  fecha_hora: Date;
}

export interface EnqueueFailedDeliveryAlertsInput {
  id_notificacion_principal_existente?: string | null;
  id_viaje: string;
  id_entrega: string;
  id_incidente: string;
  id_estudiante: string;
  id_acudientes: string[];
  total_a_bordo: number;
  fecha_hora: Date;
}

export interface EnqueueSchoolReturnFinalizedInput {
  id_notificacion_principal_existente?: string | null;
  id_viaje: string;
  id_entrega: string;
  id_acta: string;
  id_estudiante: string;
  id_acudientes: string[];
  recibido_por_coordinador: string;
  total_a_bordo: number;
  fecha_recepcion: Date;
}

/**
 * Cola ligera y no bloqueante para el encolamiento de notificaciones push
 * hacia el acudiente titular al confirmarse un abordaje (Issue #8).
 *
 * Mantiene el tiempo de respuesta del escaneo QR < 200 ms despachando el envío
 * fuera del camino crítico de la transacción de abordaje.
 */
@Injectable()
export class BoardingNotificationQueueService {
  private readonly logger = new Logger(BoardingNotificationQueueService.name);
  private readonly queuedByKey = new Map<string, QueuedBoardingNotification>();
  private readonly pendingDispatches = new Set<Promise<void>>();

  constructor(
    @Optional()
    private readonly notificationsService?: NotificationsService,
  ) {}

  enqueueGuardianBoardingNotification(
    input: EnqueueBoardingPushInput,
  ): { encolada: boolean; id_notificacion: string | null } {
    if (!input.id_acudiente_titular) {
      return { encolada: false, id_notificacion: null };
    }

    const idempotencyKey = `abordaje:${input.id_viaje}:${input.id_estudiante}`;
    const existing = this.queuedByKey.get(idempotencyKey);
    if (existing) {
      return { encolada: true, id_notificacion: existing.id_notificacion };
    }

    const idNotificacion = input.id_notificacion_existente ?? uuidv7();
    const record: QueuedBoardingNotification = {
      id_notificacion: idNotificacion,
      idempotency_key: idempotencyKey,
      id_viaje: input.id_viaje,
      id_estudiante: input.id_estudiante,
      id_acudiente: input.id_acudiente_titular,
      estado: "ENCOLADA",
      encolada_en: new Date().toISOString(),
    };
    this.queuedByKey.set(idempotencyKey, record);

    if (this.notificationsService) {
      const dispatchPromise = Promise.resolve()
        .then(async () => {
          await this.notificationsService!.sendPushNotification({
            id_estudiante: input.id_estudiante,
            id_acudiente: input.id_acudiente_titular!,
            titulo: "Abordaje confirmado",
            mensaje: "El estudiante ha subido al vehículo escolar.",
            tipo_alerta: "TRANSICION_CUSTODIA",
            datos_adicionales: {
              id_viaje: input.id_viaje,
              id_asistencia: input.id_asistencia,
              id_notificacion: idNotificacion,
              total_a_bordo: String(input.total_a_bordo),
              capacidad_nominal: String(input.capacidad_nominal),
              fecha_hora: input.fecha_hora.toISOString(),
            },
          });
          record.estado = "DESPACHADA";
        })
        .catch((error: unknown) => {
          record.estado = "FALLIDA";
          this.logger.warn(
            `Error despachando push encolado ${idNotificacion}: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => {
          this.pendingDispatches.delete(dispatchPromise);
        });

      this.pendingDispatches.add(dispatchPromise);
    }

    return { encolada: true, id_notificacion: idNotificacion };
  }

  enqueueGuardianDisembarkNotification(
    input: EnqueueDisembarkPushInput,
  ): { encoladas: number; id_notificacion_principal: string | null } {
    return this.enqueueMultiGuardian({
      id_acudientes: input.id_acudientes,
      id_viaje: input.id_viaje,
      id_estudiante: input.id_estudiante,
      keyPrefix: `descenso:${input.id_entrega}`,
      id_notificacion_principal_existente:
        input.id_notificacion_principal_existente,
      tipo_evento: "DESCENSO_EXITOSO",
      tipo_alerta: "TRANSICION_CUSTODIA",
      titulo: "Descenso y entrega confirmados",
      mensaje:
        input.tipo_receptor === "SEDE_EDUCATIVA"
          ? "El estudiante descendió de forma segura en la sede educativa."
          : "El estudiante fue entregado exitosamente al receptor autorizado.",
      datos_adicionales: {
        id_viaje: input.id_viaje,
        id_entrega: input.id_entrega,
        id_asistencia: input.id_asistencia,
        tipo_receptor: input.tipo_receptor,
        estado_custodia: input.estado_custodia,
        total_a_bordo: String(input.total_a_bordo),
        capacidad_nominal: String(input.capacidad_nominal),
        fecha_hora: input.fecha_hora.toISOString(),
      },
    });
  }

  enqueueFailedDeliveryAlerts(
    input: EnqueueFailedDeliveryAlertsInput,
  ): { encoladas: number; id_notificacion_principal: string | null } {
    return this.enqueueMultiGuardian({
      id_acudientes: input.id_acudientes,
      id_viaje: input.id_viaje,
      id_estudiante: input.id_estudiante,
      keyPrefix: `fallo_entrega:${input.id_entrega}`,
      id_notificacion_principal_existente:
        input.id_notificacion_principal_existente,
      tipo_evento: "INCIDENTE_ENTREGA",
      tipo_alerta: "EMERGENCIA",
      titulo: "Alerta crítica: retorno seguro a sede escolar",
      mensaje:
        "No compareció un receptor autorizado en la parada. El estudiante permanece a bordo rumbo a la sede escolar.",
      datos_adicionales: {
        id_viaje: input.id_viaje,
        id_entrega: input.id_entrega,
        id_incidente: input.id_incidente,
        estado_custodia: "RETORNO_SEDE_POR_FALLA_ENTREGA",
        total_a_bordo: String(input.total_a_bordo),
        fecha_hora: input.fecha_hora.toISOString(),
      },
    });
  }

  enqueueSchoolReturnFinalizedAlerts(
    input: EnqueueSchoolReturnFinalizedInput,
  ): { encoladas: number; id_notificacion_principal: string | null } {
    return this.enqueueMultiGuardian({
      id_acudientes: input.id_acudientes,
      id_viaje: input.id_viaje,
      id_estudiante: input.id_estudiante,
      keyPrefix: `acta_sede:${input.id_acta}`,
      id_notificacion_principal_existente:
        input.id_notificacion_principal_existente,
      tipo_evento: "RECEPCION_SEDE",
      tipo_alerta: "TRANSICION_CUSTODIA",
      titulo: "Estudiante recibido en sede escolar",
      mensaje:
        "El estudiante fue recibido formalmente en Coordinación de la sede escolar bajo acta de custodia.",
      datos_adicionales: {
        id_viaje: input.id_viaje,
        id_entrega: input.id_entrega,
        id_acta: input.id_acta,
        recibido_por_coordinador: input.recibido_por_coordinador,
        estado_custodia: "EN_COLEGIO",
        total_a_bordo: String(input.total_a_bordo),
        fecha_recepcion: input.fecha_recepcion.toISOString(),
      },
    });
  }

  private enqueueMultiGuardian(params: {
    id_acudientes: string[];
    id_viaje: string;
    id_estudiante: string;
    keyPrefix: string;
    id_notificacion_principal_existente?: string | null;
    tipo_evento: NonNullable<QueuedBoardingNotification["tipo_evento"]>;
    tipo_alerta: "TRANSICION_CUSTODIA" | "EMERGENCIA";
    titulo: string;
    mensaje: string;
    datos_adicionales: Record<string, string>;
  }): { encoladas: number; id_notificacion_principal: string | null } {
    const uniqueGuardians = Array.from(
      new Set(params.id_acudientes.filter((id) => Boolean(id))),
    );
    if (uniqueGuardians.length === 0) {
      return { encoladas: 0, id_notificacion_principal: null };
    }

    let encoladas = 0;
    let idPrincipal: string | null = null;

    uniqueGuardians.forEach((idAcudiente, idx) => {
      const idempotencyKey = `${params.keyPrefix}:${idAcudiente}`;
      const existing = this.queuedByKey.get(idempotencyKey);
      if (existing) {
        if (!idPrincipal) {
          idPrincipal = existing.id_notificacion;
        }
        encoladas += 1;
        return;
      }

      const idNotificacion =
        idx === 0 && params.id_notificacion_principal_existente
          ? params.id_notificacion_principal_existente
          : uuidv7();

      const record: QueuedBoardingNotification = {
        id_notificacion: idNotificacion,
        idempotency_key: idempotencyKey,
        id_viaje: params.id_viaje,
        id_estudiante: params.id_estudiante,
        id_acudiente: idAcudiente,
        tipo_evento: params.tipo_evento,
        estado: "ENCOLADA",
        encolada_en: new Date().toISOString(),
      };
      this.queuedByKey.set(idempotencyKey, record);
      if (!idPrincipal) {
        idPrincipal = idNotificacion;
      }
      encoladas += 1;

      if (this.notificationsService) {
        const dispatchPromise = Promise.resolve()
          .then(async () => {
            await this.notificationsService!.sendPushNotification({
              id_estudiante: params.id_estudiante,
              id_acudiente: idAcudiente,
              titulo: params.titulo,
              mensaje: params.mensaje,
              tipo_alerta: params.tipo_alerta,
              datos_adicionales: {
                ...params.datos_adicionales,
                id_notificacion: idNotificacion,
              },
            });
            record.estado = "DESPACHADA";
          })
          .catch((error: unknown) => {
            record.estado = "FALLIDA";
            this.logger.warn(
              `Error despachando notificación encolada ${idNotificacion}: ${error instanceof Error ? error.message : String(error)}`,
            );
          })
          .finally(() => {
            this.pendingDispatches.delete(dispatchPromise);
          });

        this.pendingDispatches.add(dispatchPromise);
      }
    });

    return { encoladas, id_notificacion_principal: idPrincipal };
  }

  listQueuedNotifications(): QueuedBoardingNotification[] {
    return Array.from(this.queuedByKey.values()).map((item) => ({ ...item }));
  }

  async flushPendingDispatches(): Promise<void> {
    await Promise.allSettled(Array.from(this.pendingDispatches));
  }
}
