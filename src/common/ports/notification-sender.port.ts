export interface NotificationMessage {
  id_usuario?: string;
  canal: "WEBSOCKET" | "PUSH_FCM" | "EMAIL" | "SMS";
  titulo: string;
  cuerpo: string;
  tipo_alerta: "INFO" | "PREVENTIVA" | "CRITICA" | "JUDICIAL";
  metadatos?: Record<string, unknown>;
}

/**
 * Puerto de Dominio: Despacho de Notificaciones en Tiempo Real (<2.5s SLA)
 */
export interface INotificationSenderPort {
  send(
    message: NotificationMessage,
  ): Promise<{ success: boolean; dispatchId: string }>;
  broadcastToRoom?(room: string, event: string, data: unknown): Promise<void>;
}
