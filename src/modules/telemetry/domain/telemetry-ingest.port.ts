import {
  RawTelemetryEnvelope,
  TelemetryIngestResult,
} from "./telemetry.types";

export const TELEMETRY_INGEST_PORT = Symbol("TELEMETRY_INGEST_PORT");
export const TELEMETRY_EVENT_DISPATCHER = Symbol("TELEMETRY_EVENT_DISPATCHER");

export type TelemetryEnvelopeHandler = (
  envelope: RawTelemetryEnvelope,
) => Promise<TelemetryIngestResult>;

/**
 * Puerto de Dominio (DIP — Issue #12):
 * Desacopla el procesador de telemetría (TelemetryService) de los canales
 * de entrada (MQTT TLS, HTTP fallback o simulador de pruebas).
 */
export interface ITelemetryIngestPort {
  registerHandler(handler: TelemetryEnvelopeHandler): void;
  publish(envelope: RawTelemetryEnvelope): Promise<TelemetryIngestResult>;
  hasHandler(): boolean;
}
