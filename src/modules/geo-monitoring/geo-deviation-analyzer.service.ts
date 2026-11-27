import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { performance } from "perf_hooks";
import { IEventDispatcherPort } from "@common/ports/event-dispatcher.port";
import { isValidLatitude, isValidLongitude } from "../routes/domain/geo.types";
import { TELEMETRY_EVENT_DISPATCHER } from "../telemetry/domain/telemetry-ingest.port";
import { TELEMETRY_GPS_RECORDED_EVENT } from "../telemetry/domain/telemetry.types";
import {
  EVALUATION_BUDGET_MS,
  GPS_SLIDING_WINDOW_SIZE,
  ROUTE_GEOMETRY_CACHE_TTL_MS,
  ROUTE_GEOMETRY_NEGATIVE_CACHE_TTL_MS,
  TRIP_STATE_IDLE_EVICTION_MS,
} from "./domain/geo-monitoring.constants";
import {
  AnomalyDetection,
  GeoAnomalyType,
  GpsSample,
  TripRouteGeometry,
} from "./domain/geo-monitoring.types";
import {
  IRouteGeometryRepository,
  ROUTE_GEOMETRY_REPOSITORY,
} from "./domain/route-geometry-repository.port";
import {
  ITelemetryAnomalyRule,
  TELEMETRY_ANOMALY_RULES,
} from "./domain/telemetry-anomaly-rule.interface";
import { GeoSecurityIncidentReporter } from "./geo-security-incident-reporter.service";

export const GEO_MONITORING_CLOCK = Symbol("GEO_MONITORING_CLOCK");
export type GeoMonitoringClock = () => number;

export type GeoEvaluationStatus =
  | "EVALUATED"
  | "REJECTED_MALFORMED"
  | "IGNORED_DUPLICATE_OR_OUT_OF_ORDER"
  | "NO_ROUTE_GEOMETRY";

export interface GeoEvaluationResult {
  readonly status: GeoEvaluationStatus;
  readonly id_viaje: string | null;
  readonly detecciones: GeoAnomalyType[];
  readonly incidentes: string[];
  /** Tiempo de evaluación espacial (geometría + reglas), sin incluir la persistencia del incidente. */
  readonly evaluation_ms: number;
}

export interface GeoMonitoringMetrics {
  readonly received: number;
  readonly evaluated: number;
  readonly rejectedMalformed: number;
  readonly ignoredDuplicateOrOutOfOrder: number;
  readonly withoutRouteGeometry: number;
  readonly detections: number;
  readonly incidentsReported: number;
  readonly ruleErrors: number;
  readonly reportErrors: number;
  readonly overBudgetEvaluations: number;
  readonly maxEvaluationMs: number;
  readonly avgEvaluationMs: number;
  readonly trackedTrips: number;
}

interface TripState {
  readonly window: GpsSample[];
  lastSeenMs: number;
}

interface CachedGeometry {
  readonly value: TripRouteGeometry | null;
  readonly expiresAtMs: number;
}

/**
 * Motor de análisis espacial en streaming (Issue #13 — RF-15, RNF-05).
 *
 * Se suscribe al evento `telemetry.gps.recorded` del Issue #12 sin modificar su flujo,
 * mantiene una ventana deslizante de las últimas 10 lecturas por viaje, cachea la
 * polilínea simplificada de la ruta y ejecuta en orden cada `ITelemetryAnomalyRule`
 * inyectada (OCP). Las detecciones se delegan a `GeoSecurityIncidentReporter`.
 *
 * Las lecturas de un mismo viaje se procesan en serie para preservar el orden de la ventana.
 */
@Injectable()
export class GeoDeviationAnalyzer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GeoDeviationAnalyzer.name);
  private readonly clock: GeoMonitoringClock;

  private readonly trips = new Map<string, TripState>();
  private readonly tripQueues = new Map<string, Promise<unknown>>();
  private readonly geometryCache = new Map<string, CachedGeometry>();
  private readonly geometryInflight = new Map<
    string,
    Promise<TripRouteGeometry | null>
  >();
  private lastEvictionMs = 0;
  private subscribed = false;

  private metrics = {
    received: 0,
    evaluated: 0,
    rejectedMalformed: 0,
    ignoredDuplicateOrOutOfOrder: 0,
    withoutRouteGeometry: 0,
    detections: 0,
    incidentsReported: 0,
    ruleErrors: 0,
    reportErrors: 0,
    overBudgetEvaluations: 0,
    maxEvaluationMs: 0,
    totalEvaluationMs: 0,
  };

  /**
   * `InMemoryEventDispatcher.publish` espera a sus suscriptores: el análisis se lanza
   * sin `await` para no frenar el flush de lotes de la ingesta telemática (Issue #12).
   * El orden por viaje lo garantiza la cola interna de `processTelemetryEvent`.
   */
  private readonly onTelemetryRecorded = async (
    payload: unknown,
  ): Promise<void> => {
    void this.processTelemetryEvent(payload).catch((err: unknown) => {
      this.logger.error(
        `Fallo inesperado del motor de desvíos: ${errorMessage(err)}`,
      );
    });
  };

  constructor(
    @Inject(TELEMETRY_EVENT_DISPATCHER)
    private readonly eventDispatcher: IEventDispatcherPort,
    @Inject(ROUTE_GEOMETRY_REPOSITORY)
    private readonly repository: IRouteGeometryRepository,
    @Inject(TELEMETRY_ANOMALY_RULES)
    private readonly rules: readonly ITelemetryAnomalyRule[],
    private readonly reporter: GeoSecurityIncidentReporter,
    @Optional()
    @Inject(GEO_MONITORING_CLOCK)
    clock?: GeoMonitoringClock,
  ) {
    this.clock = clock ?? (() => Date.now());
  }

  onModuleInit(): void {
    if (!this.eventDispatcher.subscribe) {
      this.logger.warn(
        "El despachador de telemetría no admite suscripciones: el motor de desvíos queda inactivo.",
      );
      return;
    }
    this.eventDispatcher.subscribe(
      TELEMETRY_GPS_RECORDED_EVENT,
      this.onTelemetryRecorded,
    );
    this.subscribed = true;
    this.logger.log(
      `Motor de desvíos suscrito a "${TELEMETRY_GPS_RECORDED_EVENT}" con ${this.rules.length} regla(s): ${this.rules.map((r) => r.code).join(", ")}`,
    );
  }

  onModuleDestroy(): void {
    const dispatcher = this.eventDispatcher as IEventDispatcherPort & {
      unsubscribe?: (
        eventName: string,
        handler: (payload: unknown) => Promise<void>,
      ) => void;
    };
    if (this.subscribed && dispatcher.unsubscribe) {
      dispatcher.unsubscribe(
        TELEMETRY_GPS_RECORDED_EVENT,
        this.onTelemetryRecorded,
      );
    }
    this.subscribed = false;
  }

  /** Punto de entrada por coordenada; seguro ante payloads malformados. */
  async processTelemetryEvent(payload: unknown): Promise<GeoEvaluationResult> {
    this.metrics.received += 1;
    const sample = parseGpsSample(payload);
    if (!sample) {
      this.metrics.rejectedMalformed += 1;
      this.logger.warn(
        "Evento de telemetría malformado descartado por el motor de desvíos.",
      );
      return emptyResult("REJECTED_MALFORMED", null);
    }

    const previous = this.tripQueues.get(sample.id_viaje) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.evaluateSample(sample));
    this.tripQueues.set(sample.id_viaje, current);
    void current.finally(() => {
      if (this.tripQueues.get(sample.id_viaje) === current) {
        this.tripQueues.delete(sample.id_viaje);
      }
    });
    return current;
  }

  /** Invalida la geometría cacheada (p. ej. tras editar la polilínea de la ruta). */
  invalidateRouteGeometry(idViaje?: string): void {
    if (idViaje) {
      this.geometryCache.delete(idViaje);
    } else {
      this.geometryCache.clear();
    }
  }

  getMetrics(): GeoMonitoringMetrics {
    const { totalEvaluationMs, ...rest } = this.metrics;
    return {
      ...rest,
      maxEvaluationMs: Number(rest.maxEvaluationMs.toFixed(3)),
      avgEvaluationMs:
        rest.evaluated > 0
          ? Number((totalEvaluationMs / rest.evaluated).toFixed(3))
          : 0,
      trackedTrips: this.trips.size,
    };
  }

  private async evaluateSample(
    sample: GpsSample,
  ): Promise<GeoEvaluationResult> {
    const startedAt = performance.now();
    const nowMs = this.clock();
    this.evictIdleTrips(nowMs);

    const trip = this.getTripState(sample.id_viaje);
    const last = trip.window[trip.window.length - 1];
    if (
      last &&
      (last.id_gps === sample.id_gps ||
        sample.fecha_hora.getTime() <= last.fecha_hora.getTime())
    ) {
      this.metrics.ignoredDuplicateOrOutOfOrder += 1;
      return emptyResult("IGNORED_DUPLICATE_OR_OUT_OF_ORDER", sample.id_viaje);
    }

    trip.window.push(sample);
    if (trip.window.length > GPS_SLIDING_WINDOW_SIZE) {
      trip.window.shift();
    }
    trip.lastSeenMs = nowMs;

    const route = await this.getRouteGeometry(sample.id_viaje, nowMs);
    if (!route) {
      this.metrics.withoutRouteGeometry += 1;
      return emptyResult("NO_ROUTE_GEOMETRY", sample.id_viaje);
    }

    const window = trip.window.slice();
    const detections: AnomalyDetection[] = [];
    for (const rule of this.rules) {
      try {
        const detection = await rule.evaluate({ sample, window, route });
        if (detection) {
          detections.push(detection);
        }
      } catch (err: unknown) {
        this.metrics.ruleErrors += 1;
        this.logger.error(
          `Regla ${rule.code} falló en viaje ${sample.id_viaje}: ${errorMessage(err)}`,
        );
      }
    }

    const evaluationMs = performance.now() - startedAt;
    this.recordEvaluationTime(evaluationMs, sample.id_viaje);
    this.metrics.detections += detections.length;

    const incidentes: string[] = [];
    for (const detection of detections) {
      try {
        const outcome = await this.reporter.report(detection, sample, route);
        incidentes.push(outcome.id_incidente);
        this.metrics.incidentsReported += 1;
      } catch (err: unknown) {
        this.metrics.reportErrors += 1;
        this.logger.error(
          `No se pudo registrar el incidente ${detection.tipo_incidente} del viaje ${sample.id_viaje}: ${errorMessage(err)}`,
        );
      }
    }

    return {
      status: "EVALUATED",
      id_viaje: sample.id_viaje,
      detecciones: detections.map((d) => d.tipo_incidente),
      incidentes,
      evaluation_ms: Number(evaluationMs.toFixed(3)),
    };
  }

  private recordEvaluationTime(evaluationMs: number, idViaje: string): void {
    this.metrics.evaluated += 1;
    this.metrics.totalEvaluationMs += evaluationMs;
    this.metrics.maxEvaluationMs = Math.max(
      this.metrics.maxEvaluationMs,
      evaluationMs,
    );
    if (evaluationMs >= EVALUATION_BUDGET_MS) {
      this.metrics.overBudgetEvaluations += 1;
      this.logger.warn(
        `Evaluación geoespacial de ${evaluationMs.toFixed(1)} ms en viaje ${idViaje} excede el presupuesto de ${EVALUATION_BUDGET_MS} ms (DoD #13).`,
      );
    }
  }

  private getTripState(idViaje: string): TripState {
    let trip = this.trips.get(idViaje);
    if (!trip) {
      trip = { window: [], lastSeenMs: this.clock() };
      this.trips.set(idViaje, trip);
    }
    return trip;
  }

  private async getRouteGeometry(
    idViaje: string,
    nowMs: number,
  ): Promise<TripRouteGeometry | null> {
    const cached = this.geometryCache.get(idViaje);
    if (cached && cached.expiresAtMs > nowMs) {
      return cached.value;
    }

    const inflight = this.geometryInflight.get(idViaje);
    if (inflight) {
      return inflight;
    }

    const request = (async () => {
      try {
        const value = await this.repository.loadTripRouteGeometry(idViaje);
        const ttl =
          value && value.polilinea_simplificada.length > 0
            ? ROUTE_GEOMETRY_CACHE_TTL_MS
            : ROUTE_GEOMETRY_NEGATIVE_CACHE_TTL_MS;
        const normalized =
          value && value.polilinea_simplificada.length > 0 ? value : null;
        this.geometryCache.set(idViaje, {
          value: normalized,
          expiresAtMs: nowMs + ttl,
        });
        return normalized;
      } catch (err: unknown) {
        this.logger.error(
          `No se pudo cargar la geometría de ruta del viaje ${idViaje}: ${errorMessage(err)}`,
        );
        return null;
      } finally {
        this.geometryInflight.delete(idViaje);
      }
    })();
    this.geometryInflight.set(idViaje, request);
    return request;
  }

  private evictIdleTrips(nowMs: number): void {
    if (nowMs - this.lastEvictionMs < 60_000) {
      return;
    }
    this.lastEvictionMs = nowMs;
    for (const [idViaje, trip] of this.trips) {
      if (nowMs - trip.lastSeenMs > TRIP_STATE_IDLE_EVICTION_MS) {
        this.trips.delete(idViaje);
        this.geometryCache.delete(idViaje);
        for (const rule of this.rules) {
          rule.resetTrip(idViaje);
        }
      }
    }
  }
}

/** Validación de cada lectura entrante antes de usarla en los detectores. */
export function parseGpsSample(payload: unknown): GpsSample | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const p = payload as Record<string, unknown>;
  const isNonEmptyString = (v: unknown): v is string =>
    typeof v === "string" && v.trim().length > 0;

  if (
    !isNonEmptyString(p.id_gps) ||
    !isNonEmptyString(p.id_viaje) ||
    !isNonEmptyString(p.id_vehiculo) ||
    !isValidLatitude(p.latitud) ||
    !isValidLongitude(p.longitud) ||
    typeof p.velocidad_kmh !== "number" ||
    !Number.isFinite(p.velocidad_kmh) ||
    p.velocidad_kmh < 0
  ) {
    return null;
  }

  const fecha =
    p.fecha_hora instanceof Date
      ? p.fecha_hora
      : typeof p.fecha_hora === "string"
        ? new Date(p.fecha_hora)
        : null;
  if (!fecha || Number.isNaN(fecha.getTime())) {
    return null;
  }

  return {
    id_gps: p.id_gps,
    id_viaje: p.id_viaje,
    id_vehiculo: p.id_vehiculo,
    placa: isNonEmptyString(p.placa) ? p.placa : "DESCONOCIDA",
    latitud: p.latitud,
    longitud: p.longitud,
    velocidad_kmh: p.velocidad_kmh,
    fecha_hora: fecha,
  };
}

function emptyResult(
  status: GeoEvaluationStatus,
  idViaje: string | null,
): GeoEvaluationResult {
  return {
    status,
    id_viaje: idViaje,
    detecciones: [],
    incidentes: [],
    evaluation_ms: 0,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
