import { Injectable } from "@nestjs/common";
import {
  GPS_EMIT_THROTTLE_MS,
  MAX_TRIP_SUBSCRIPTIONS_PER_SOCKET,
} from "./domain/realtime.constants";
import { StreamingPrincipal } from "./domain/realtime.types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidTripId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

interface TripStreamState {
  /** Último estado comunicado al cliente (`trip:stream_status`). */
  transmitting: boolean;
  lastEmitMs: number | null;
}

interface SocketSession {
  readonly principal: StreamingPrincipal;
  readonly trips: Map<string, TripStreamState>;
}

export type AddTripResult = "ADDED" | "ALREADY_SUBSCRIBED" | "LIMIT_REACHED";

/**
 * Gestor de suscripciones por socket (Issue #14).
 * Mantiene el principal autenticado, las salas de viaje, el último estado de
 * transmisión comunicado y el throttle de 1 frame cada 2 s por cliente.
 */
@Injectable()
export class TripSubscriptionManager {
  private readonly sessions = new Map<string, SocketSession>();

  registerSocket(socketId: string, principal: StreamingPrincipal): void {
    this.sessions.set(socketId, { principal, trips: new Map() });
  }

  unregisterSocket(socketId: string): void {
    this.sessions.delete(socketId);
  }

  getPrincipal(socketId: string): StreamingPrincipal | null {
    return this.sessions.get(socketId)?.principal ?? null;
  }

  addTrip(
    socketId: string,
    idViaje: string,
    transmitting: boolean,
  ): AddTripResult {
    const session = this.sessions.get(socketId);
    if (!session) {
      return "LIMIT_REACHED";
    }
    const existing = session.trips.get(idViaje);
    if (existing) {
      existing.transmitting = transmitting;
      return "ALREADY_SUBSCRIBED";
    }
    if (session.trips.size >= MAX_TRIP_SUBSCRIPTIONS_PER_SOCKET) {
      return "LIMIT_REACHED";
    }
    session.trips.set(idViaje, { transmitting, lastEmitMs: null });
    return "ADDED";
  }

  removeTrip(socketId: string, idViaje: string): void {
    this.sessions.get(socketId)?.trips.delete(idViaje);
  }

  isSubscribed(socketId: string, idViaje: string): boolean {
    return this.sessions.get(socketId)?.trips.has(idViaje) ?? false;
  }

  /** Registra el nuevo estado de transmisión; devuelve `true` si cambió. */
  updateTransmitting(
    socketId: string,
    idViaje: string,
    transmitting: boolean,
  ): boolean {
    const state = this.sessions.get(socketId)?.trips.get(idViaje);
    if (!state || state.transmitting === transmitting) {
      return false;
    }
    state.transmitting = transmitting;
    return true;
  }

  /**
   * Throttle de borde anterior: el frame se emite si pasaron ≥ 2 s desde el último;
   * si no, se descarta (nunca se retrasa, para conservar la latencia < 1 s).
   */
  tryAcquireEmitSlot(
    socketId: string,
    idViaje: string,
    nowMs: number,
  ): boolean {
    const state = this.sessions.get(socketId)?.trips.get(idViaje);
    if (!state) {
      return false;
    }
    if (
      state.lastEmitMs !== null &&
      nowMs - state.lastEmitMs < GPS_EMIT_THROTTLE_MS
    ) {
      return false;
    }
    state.lastEmitMs = nowMs;
    return true;
  }

  countSockets(): number {
    return this.sessions.size;
  }
}
