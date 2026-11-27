import { Injectable } from "@nestjs/common";
import {
  ITelemetryIngestPort,
  TelemetryEnvelopeHandler,
} from "../domain/telemetry-ingest.port";
import {
  RawTelemetryEnvelope,
  TelemetryIngestResult,
} from "../domain/telemetry.types";

/**
 * Implementación en memoria del puerto `ITelemetryIngestPort`.
 * Canaliza sobres provenientes de MQTT TLS, HTTP fallback o simuladores
 * hacia el procesador de dominio (`TelemetryService`) sin acoplarlo al transporte.
 */
@Injectable()
export class TelemetryIngestChannel implements ITelemetryIngestPort {
  private handler: TelemetryEnvelopeHandler | null = null;

  registerHandler(handler: TelemetryEnvelopeHandler): void {
    this.handler = handler;
  }

  hasHandler(): boolean {
    return this.handler !== null;
  }

  async publish(envelope: RawTelemetryEnvelope): Promise<TelemetryIngestResult> {
    if (!this.handler) {
      throw new Error(
        "No existe un procesador registrado en ITelemetryIngestPort.",
      );
    }
    return this.handler(envelope);
  }
}
