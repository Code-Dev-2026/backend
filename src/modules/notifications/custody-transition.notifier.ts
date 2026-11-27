import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  CustodyHistoryRecord,
  FsmCustodyState,
} from "../custody/domain/custody.types";
import {
  INotificationRecipientDirectory,
  NOTIFICATION_RECIPIENT_DIRECTORY,
} from "./domain/notification-dispatch.ports";
import {
  DispatchOutcome,
  NotificationTypeCode,
} from "./domain/notification-dispatch.types";
import { NotificationDispatcherService } from "./notification-dispatcher.service";

interface TransitionNotificationTemplate {
  readonly codigo_tipo: NotificationTypeCode;
  readonly titulo: string;
  readonly mensaje: string;
  readonly silenciable: boolean;
}

/**
 * Clasificación de cada estado destino de la FSM de custodia (Issue #7) en su
 * `tipo_notificacion` (V007). Añadir un evento nuevo es añadir una entrada (OCP).
 */
export const CUSTODY_TRANSITION_TEMPLATES: Readonly<
  Partial<Record<FsmCustodyState, TransitionNotificationTemplate>>
> = {
  [FsmCustodyState.EN_ESPERA_ABORDAJE]: {
    codigo_tipo: "PROXIMIDAD_PARADA",
    titulo: "Vehículo en aproximación",
    mensaje: "El vehículo escolar está llegando a la parada de abordaje.",
    silenciable: true,
  },
  [FsmCustodyState.A_BORDO_VEHICULO]: {
    codigo_tipo: "ABORDAJE_EXITOSO",
    titulo: "Abordaje confirmado",
    mensaje: "El estudiante ha subido al vehículo escolar.",
    silenciable: false,
  },
  [FsmCustodyState.ENTREGADO_ACUDIENTE]: {
    codigo_tipo: "DESCENSO_EXITOSO",
    titulo: "Descenso y entrega confirmados",
    mensaje: "El estudiante fue entregado en la parada autorizada.",
    silenciable: false,
  },
  [FsmCustodyState.EN_COLEGIO]: {
    codigo_tipo: "DESCENSO_EXITOSO",
    titulo: "Llegada a la sede confirmada",
    mensaje: "El estudiante descendió de forma segura en la sede educativa.",
    silenciable: false,
  },
  [FsmCustodyState.RETORNO_SEDE_POR_FALLA_ENTREGA]: {
    codigo_tipo: "INCIDENTE_ENTREGA",
    titulo: "Alerta crítica: retorno seguro a sede escolar",
    mensaje:
      "No se pudo entregar al menor en la parada; permanece a bordo rumbo a la sede escolar.",
    silenciable: false,
  },
};

/**
 * Notifica a los acudientes legitimados cada transición de custodia aplicada por el
 * caso de uso de la FSM (`POST /custody/transitions`). Las transiciones internas del
 * abordaje (#8) y del desembarque (#9) se notifican desde su propia cola.
 */
@Injectable()
export class CustodyTransitionNotifier {
  private readonly logger = new Logger(CustodyTransitionNotifier.name);

  constructor(
    private readonly dispatcher: NotificationDispatcherService,
    @Inject(NOTIFICATION_RECIPIENT_DIRECTORY)
    private readonly recipients: INotificationRecipientDirectory,
  ) {}

  /** No bloquea: resuelve destinatarios y encola; la promesa es para pruebas. */
  async notifyTransition(
    history: CustodyHistoryRecord,
  ): Promise<DispatchOutcome[]> {
    const template = CUSTODY_TRANSITION_TEMPLATES[history.estado_destino];
    if (!template) {
      return [];
    }

    let guardians: string[];
    try {
      guardians = await this.recipients.listGuardianIdsOfStudent(
        history.id_estudiante,
      );
    } catch (err: unknown) {
      this.logger.error(
        `No se pudieron resolver los acudientes de ${history.id_estudiante}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }

    return Promise.all(
      Array.from(new Set(guardians)).map((idAcudiente) =>
        this.dispatcher.enqueue({
          idempotency_key: `transicion:${history.id_historial}:${idAcudiente}`,
          codigo_tipo: template.codigo_tipo,
          id_acudiente: idAcudiente,
          id_estudiante: history.id_estudiante,
          id_viaje: history.id_viaje,
          titulo: template.titulo,
          mensaje: template.mensaje,
          silenciable: template.silenciable,
          payload: {
            id_viaje: history.id_viaje,
            id_historial: history.id_historial,
            estado_origen: history.estado_origen,
            estado_custodia: history.estado_destino,
            disparador_evento: history.disparador_evento,
            fecha_hora: history.fecha_hora.toISOString(),
          },
          ocurrido_en: history.fecha_hora,
        }),
      ),
    );
  }
}
