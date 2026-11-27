import { RoleEnum } from "@common/enums/role.enum";

/**
 * Constantes de la pasarela WebSocket de seguimiento en vivo (Issue #14 — RF-10, RNF-02, RNF-05).
 */

/** Namespace Socket.IO dedicado al stream telemático (separado de `/asistencia`). */
export const TELEMETRY_NAMESPACE = "/telemetria";

/** Prefijo de sala segmentada por viaje: `trip:{id_viaje}`. */
export const TRIP_ROOM_PREFIX = "trip:";

export const tripRoom = (idViaje: string): string =>
  `${TRIP_ROOM_PREFIX}${idViaje}`;

/** Mitigación de saturación de CPU: máximo 1 frame GPS cada 2 s por cliente. */
export const GPS_EMIT_THROTTLE_MS = 2000;

/** DoD: latencia de despacho del frame GPS inferior a 1 s. */
export const GPS_DISPATCH_LATENCY_BUDGET_MS = 1000;

/** Límite de salas de viaje simultáneas por socket (evita abuso de suscripciones). */
export const MAX_TRIP_SUBSCRIPTIONS_PER_SOCKET = 5;

/** Estado de custodia que habilita el stream GPS hacia el acudiente. */
export const STREAMING_ENABLED_CUSTODY_STATE = "A_BORDO_VEHICULO";

/**
 * Personal operativo/institucional que recibe el stream del viaje sin filtro de custodia.
 * Se evalúa con `userHasAnyRole`, por lo que incluye las equivalencias de BD/RBAC.
 */
export const STAFF_STREAMING_ROLES: readonly string[] = [
  RoleEnum.ADMIN,
  RoleEnum.SCHOOL_COORDINATOR,
  RoleEnum.TRANSPORT_ADMIN,
  RoleEnum.MONITOR,
];

/** Roles de familia: requieren parentesco con un estudiante del viaje. */
export const GUARDIAN_STREAMING_ROLES: readonly string[] = [RoleEnum.PARENT];

/** Eventos cliente → servidor. */
export const CLIENT_EVENTS = {
  SUBSCRIBE: "trip:subscribe",
  UNSUBSCRIBE: "trip:unsubscribe",
} as const;

/** Eventos servidor → cliente. */
export const SERVER_EVENTS = {
  GPS: "trip:gps",
  STREAM_STATUS: "trip:stream_status",
  AUTH_EXPIRED: "auth:expired",
} as const;

/** Códigos de rechazo del handshake (`connect_error.data.code`). */
export const HANDSHAKE_ERROR_CODES = {
  TOKEN_REQUIRED: "TOKEN_REQUIRED",
  TOKEN_INVALID: "TOKEN_INVALID",
  MFA_REQUIRED: "MFA_REQUIRED",
  ROLE_NOT_ALLOWED: "ROLE_NOT_ALLOWED",
} as const;
