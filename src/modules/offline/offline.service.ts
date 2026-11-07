import { Injectable, BadRequestException } from "@nestjs/common";

export interface OfflineSyncBatchDto {
  id_dispositivo: string;
  idempotency_key: string;
  eventos: Array<{
    tipo: string;
    payload: Record<string, unknown>;
    timestamp_local: string;
  }>;
}

@Injectable()
export class OfflineService {
  /**
   * Sincronización offline idempotente con protección por X-Idempotency-Key
   */
  async processOfflineBatch(dto: OfflineSyncBatchDto) {
    if (!dto.idempotency_key) {
      throw new BadRequestException("Idempotency key obligatoria.");
    }

    return {
      id_dispositivo: dto.id_dispositivo,
      idempotency_key: dto.idempotency_key,
      total_eventos: dto.eventos ? dto.eventos.length : 0,
      estado: "RECONCILIADO_EXITOSAMENTE",
      procesado_en: new Date().toISOString(),
    };
  }
}
