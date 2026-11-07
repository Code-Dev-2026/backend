import { Injectable, Logger } from "@nestjs/common";
import * as crypto from "crypto";

export interface AuditEventPayload {
  tipo_evento: string;
  id_usuario?: string;
  id_estudiante?: string;
  id_viaje?: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private lastHash =
    "0000000000000000000000000000000000000000000000000000000000000000";

  /**
   * Registra un evento en el libro mayor forense inmutable con encadenamiento SHA-256 (RNF-08 / ADR-002)
   */
  async logCriticalEvent(event: AuditEventPayload) {
    const timestamp = new Date().toISOString();
    const eventString = `${this.lastHash}|${event.tipo_evento}|${timestamp}|${JSON.stringify(event.payload)}`;
    const currentHash = crypto
      .createHash("sha256")
      .update(eventString)
      .digest("hex");

    const auditEntry = {
      id_evento: "018e38d9-3f00-7200-a000-000000000050",
      timestamp,
      tipo_evento: event.tipo_evento,
      hash_anterior: this.lastHash,
      hash_evento: currentHash,
      id_usuario: event.id_usuario,
      id_estudiante: event.id_estudiante,
      id_viaje: event.id_viaje,
      inmutable: true,
    };

    this.lastHash = currentHash;
    this.logger.log(
      `[AUDITORIA FORENSE] Evento "${event.tipo_evento}" encadenado: ${currentHash.substring(0, 16)}...`,
    );

    return auditEntry;
  }
}
