import { Injectable } from "@nestjs/common";
import {
  PROLONGED_STOP_DURATION_THRESHOLD_MS,
  PROLONGED_STOP_SPEED_THRESHOLD_KMH,
} from "../domain/geo-monitoring.constants";
import {
  AnomalyDetection,
  AnomalyEvaluationContext,
  GpsSample,
  StopGeofence,
} from "../domain/geo-monitoring.types";
import { findContainingStop } from "../domain/polyline-distance";
import { ITelemetryAnomalyRule } from "../domain/telemetry-anomaly-rule.interface";

interface StopTripState {
  episodeStart: Date | null;
  alerted: boolean;
}

/**
 * Detector de detención prolongada — Issue #13, RF-15.
 *
 * Una lectura es "inmóvil fuera de parada" si `velocidad_kmh < 3` y la coordenada no
 * está dentro de la geocerca de ninguna parada de la ruta. El inicio del episodio se
 * obtiene de la racha final de lecturas inmóviles dentro de la ventana de las últimas
 * 10 lecturas GPS y se conserva mientras la racha continúe. Se alerta cuando la racha
 * supera estrictamente 5 minutos, una sola vez por episodio.
 */
@Injectable()
export class ProlongedStopDetector implements ITelemetryAnomalyRule {
  readonly code = "DETENCION_PROLONGADA" as const;
  private readonly states = new Map<string, StopTripState>();

  async evaluate(
    context: AnomalyEvaluationContext,
  ): Promise<AnomalyDetection | null> {
    const { sample, window, route } = context;
    const state = this.getState(sample.id_viaje);

    if (!this.isStationaryOutsideStop(sample, route.paradas)) {
      state.episodeStart = null;
      state.alerted = false;
      return null;
    }

    if (!state.episodeStart) {
      state.episodeStart = this.trailingStationaryRunStart(
        window,
        route.paradas,
      );
    }

    const durationMs =
      sample.fecha_hora.getTime() - state.episodeStart.getTime();
    if (state.alerted || durationMs <= PROLONGED_STOP_DURATION_THRESHOLD_MS) {
      return null;
    }

    state.alerted = true;
    const duracionSegundos = Math.round(durationMs / 1000);
    return {
      tipo_incidente: this.code,
      severidad: "CRITICO",
      descripcion: `Detención prolongada en la ruta ${route.codigo_ruta}: el vehículo ${sample.placa} permanece inmóvil (< ${PROLONGED_STOP_SPEED_THRESHOLD_KMH} km/h) fuera de geocerca de parada durante ${duracionSegundos} s (umbral ${PROLONGED_STOP_DURATION_THRESHOLD_MS / 1000} s).`,
      coordenadas: { latitud: sample.latitud, longitud: sample.longitud },
      fecha_hora: sample.fecha_hora,
      metricas: {
        duracion_segundos: duracionSegundos,
        umbral_segundos: PROLONGED_STOP_DURATION_THRESHOLD_MS / 1000,
        velocidad_kmh: sample.velocidad_kmh,
      },
    };
  }

  resetTrip(idViaje: string): void {
    this.states.delete(idViaje);
  }

  private isStationaryOutsideStop(
    sample: GpsSample,
    paradas: readonly StopGeofence[],
  ): boolean {
    return (
      sample.velocidad_kmh < PROLONGED_STOP_SPEED_THRESHOLD_KMH &&
      findContainingStop(
        { latitud: sample.latitud, longitud: sample.longitud },
        paradas,
      ) === null
    );
  }

  private trailingStationaryRunStart(
    window: readonly GpsSample[],
    paradas: readonly StopGeofence[],
  ): Date {
    let start = window[window.length - 1].fecha_hora;
    for (let i = window.length - 1; i >= 0; i--) {
      if (!this.isStationaryOutsideStop(window[i], paradas)) {
        break;
      }
      start = window[i].fecha_hora;
    }
    return start;
  }

  private getState(idViaje: string): StopTripState {
    let state = this.states.get(idViaje);
    if (!state) {
      state = { episodeStart: null, alerted: false };
      this.states.set(idViaje, state);
    }
    return state;
  }
}
