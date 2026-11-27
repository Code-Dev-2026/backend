/**
 * Umbrales del motor de análisis espacial en streaming (Issue #13 — RF-15, RNF-05).
 * Los valores provienen literalmente del issue; no son configurables por entorno.
 */

/** Desvío significativo: distancia perpendicular al trazado oficial estrictamente mayor a 300 m. */
export const ROUTE_DEVIATION_THRESHOLD_METERS = 300;

/**
 * Mitigación de falsos positivos (cañones urbanos): lecturas consecutivas confirmadas
 * fuera del umbral antes de disparar la alerta crítica.
 */
export const ROUTE_DEVIATION_CONFIRMATION_READINGS = 3;

/** Detención prolongada: velocidad estrictamente menor a 3 km/h. */
export const PROLONGED_STOP_SPEED_THRESHOLD_KMH = 3;

/** Detención prolongada: inmovilidad fuera de parada estrictamente mayor a 5 minutos. */
export const PROLONGED_STOP_DURATION_THRESHOLD_MS = 5 * 60 * 1000;

/** Ventana deslizante de lecturas GPS por viaje usada por los detectores. */
export const GPS_SLIDING_WINDOW_SIZE = 10;

/** DoD: tiempo de evaluación por coordenada inferior a 100 ms. */
export const EVALUATION_BUDGET_MS = 100;

/** Vigencia del caché en memoria de la polilínea simplificada y geocercas de parada. */
export const ROUTE_GEOMETRY_CACHE_TTL_MS = 5 * 60 * 1000;

/** Vigencia del caché negativo (viaje sin ruta resuelta) para no saturar la base de datos. */
export const ROUTE_GEOMETRY_NEGATIVE_CACHE_TTL_MS = 30 * 1000;

/**
 * Tolerancia de `ST_Simplify` en grados (≈ 5,5 m en el ecuador). El error introducido
 * por la simplificación queda muy por debajo del umbral de 300 m y, además, toda alerta
 * crítica se confirma contra la polilínea oficial completa con `ST_DWithin`.
 */
export const POLYLINE_SIMPLIFY_TOLERANCE_DEGREES = 0.00005;

/** Viajes sin lecturas durante este lapso se retiran del estado en memoria del motor. */
export const TRIP_STATE_IDLE_EVICTION_MS = 60 * 60 * 1000;

/** Evento de dominio publicado tras registrar un incidente de seguridad geoespacial. */
export const GEO_SECURITY_INCIDENT_EVENT = "geo.security.incident";

/** Evento Socket.IO emitido a la sala de Coordinación. */
export const COORDINATION_ROUTE_SECURITY_ALERT_EVENT =
  "coordination:route_security_alert";
