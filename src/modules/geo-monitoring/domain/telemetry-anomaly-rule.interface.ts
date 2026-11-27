import {
  AnomalyDetection,
  AnomalyEvaluationContext,
  GeoAnomalyType,
} from "./geo-monitoring.types";

export const TELEMETRY_ANOMALY_RULES = Symbol("TELEMETRY_ANOMALY_RULES");

/**
 * Regla de anomalía telemática (OCP — Issue #13).
 *
 * `GeoDeviationAnalyzer` recorre la colección inyectada bajo `TELEMETRY_ANOMALY_RULES`
 * sin conocer las implementaciones concretas: añadir un nuevo chequeo consiste en
 * registrar otra clase que implemente esta interfaz, sin tocar el flujo de procesamiento.
 */
export interface ITelemetryAnomalyRule {
  readonly code: GeoAnomalyType;

  /**
   * Evalúa la lectura más reciente. Devuelve una detección solo cuando la anomalía
   * se confirma y aún no fue reportada en el episodio actual; de lo contrario `null`.
   */
  evaluate(context: AnomalyEvaluationContext): Promise<AnomalyDetection | null>;

  /** Libera el estado interno asociado a un viaje. */
  resetTrip(idViaje: string): void;
}
