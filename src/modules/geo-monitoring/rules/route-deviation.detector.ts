import { Inject, Injectable } from "@nestjs/common";
import {
  ROUTE_DEVIATION_CONFIRMATION_READINGS,
  ROUTE_DEVIATION_THRESHOLD_METERS,
} from "../domain/geo-monitoring.constants";
import {
  AnomalyDetection,
  AnomalyEvaluationContext,
} from "../domain/geo-monitoring.types";
import { distancePointToPolylineMeters } from "../domain/polyline-distance";
import {
  IRouteGeometryRepository,
  ROUTE_GEOMETRY_REPOSITORY,
} from "../domain/route-geometry-repository.port";
import { ITelemetryAnomalyRule } from "../domain/telemetry-anomaly-rule.interface";

interface DeviationTripState {
  consecutiveOutside: number;
  alerted: boolean;
}

/**
 * Detector de desvío significativo de ruta (> 300 m) — Issue #13, RF-15.
 *
 * 1. Ruta rápida en memoria: distancia perpendicular a la polilínea simplificada cacheada.
 * 2. Antifalsos positivos: exige 3 lecturas consecutivas fuera del umbral.
 * 3. Confirmación exacta contra la polilínea oficial completa (`ST_DWithin` + `ST_Distance`).
 * 4. Una sola alerta por episodio: se rearma cuando el vehículo vuelve a ≤ 300 m.
 */
@Injectable()
export class RouteDeviationDetector implements ITelemetryAnomalyRule {
  readonly code = "DESVIO_RUTA_SIGNIFICATIVO" as const;
  private readonly states = new Map<string, DeviationTripState>();

  constructor(
    @Inject(ROUTE_GEOMETRY_REPOSITORY)
    private readonly repository: IRouteGeometryRepository,
  ) {}

  async evaluate(
    context: AnomalyEvaluationContext,
  ): Promise<AnomalyDetection | null> {
    const { sample, route } = context;
    const state = this.getState(sample.id_viaje);
    const punto = { latitud: sample.latitud, longitud: sample.longitud };

    const fastDistance = distancePointToPolylineMeters(
      punto,
      route.polilinea_simplificada,
    );
    if (!Number.isFinite(fastDistance)) {
      return null;
    }

    if (fastDistance <= ROUTE_DEVIATION_THRESHOLD_METERS) {
      state.consecutiveOutside = 0;
      state.alerted = false;
      return null;
    }

    state.consecutiveOutside += 1;
    if (
      state.alerted ||
      state.consecutiveOutside < ROUTE_DEVIATION_CONFIRMATION_READINGS
    ) {
      return null;
    }

    const measurement = await this.repository.measureDistanceToRoute(
      route.id_ruta,
      punto,
      ROUTE_DEVIATION_THRESHOLD_METERS,
    );
    if (!measurement) {
      return null;
    }

    if (
      measurement.dentro_umbral ||
      measurement.distancia_metros <= ROUTE_DEVIATION_THRESHOLD_METERS
    ) {
      // La simplificación de la polilínea produjo un candidato falso: se descarta el episodio.
      state.consecutiveOutside = 0;
      return null;
    }

    state.alerted = true;
    const distancia = Number(measurement.distancia_metros.toFixed(2));
    return {
      tipo_incidente: this.code,
      severidad: "CRITICO",
      descripcion: `Desvío significativo de la ruta ${route.codigo_ruta}: el vehículo ${sample.placa} se encuentra a ${distancia} m de la polilínea oficial (umbral ${ROUTE_DEVIATION_THRESHOLD_METERS} m) tras ${state.consecutiveOutside} lecturas GPS consecutivas fuera del trazado.`,
      coordenadas: punto,
      fecha_hora: sample.fecha_hora,
      metricas: {
        distancia_metros: distancia,
        umbral_metros: ROUTE_DEVIATION_THRESHOLD_METERS,
        lecturas_consecutivas_fuera: state.consecutiveOutside,
      },
    };
  }

  resetTrip(idViaje: string): void {
    this.states.delete(idViaje);
  }

  private getState(idViaje: string): DeviationTripState {
    let state = this.states.get(idViaje);
    if (!state) {
      state = { consecutiveOutside: 0, alerted: false };
      this.states.set(idViaje, state);
    }
    return state;
  }
}
