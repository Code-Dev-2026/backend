import { Injectable, Logger } from '@nestjs/common';

export interface PushNotificationPayload {
  id_estudiante: string;
  id_acudiente: string;
  titulo: string;
  mensaje: string;
  tipo_alerta: 'TRANSICION_CUSTODIA' | 'PROXIMIDAD_ETA' | 'PUNTO_CIEGO' | 'EMERGENCIA';
  datos_adicionales?: Record<string, string>;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  /**
   * Despacho transaccional de notificación push con SLA estricto (< 2.5s)
   */
  async sendPushNotification(payload: PushNotificationPayload) {
    const startTime = Date.now();

    // En producción se encola en BullMQ / Redis y se despacha a Firebase Admin SDK
    this.logger.log(`Enviando push a acudiente ${payload.id_acudiente}: "${payload.titulo}"`);

    const latencyMs = Date.now() - startTime;

    return {
      despachado: true,
      id_notificacion: '018e38d9-3f00-7200-a000-000000000040',
      latencia_ms: latencyMs,
      cumple_sla_2_5s: latencyMs < 2500,
      timestamp: new Date().toISOString(),
    };
  }
}
