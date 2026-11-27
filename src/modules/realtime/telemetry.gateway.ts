import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { performance } from "perf_hooks";
import type { Namespace, Socket } from "socket.io";
import { IEventDispatcherPort } from "@common/ports/event-dispatcher.port";
import { TELEMETRY_EVENT_DISPATCHER } from "../telemetry/domain/telemetry-ingest.port";
import { TELEMETRY_GPS_RECORDED_EVENT } from "../telemetry/domain/telemetry.types";
import {
  CLIENT_EVENTS,
  GPS_DISPATCH_LATENCY_BUDGET_MS,
  MAX_TRIP_SUBSCRIPTIONS_PER_SOCKET,
  SERVER_EVENTS,
  familyRoom,
  TELEMETRY_NAMESPACE,
  tripRoom,
} from "./domain/realtime.constants";
import {
  GUARDIAN_LINK_REPOSITORY,
  IGuardianLinkRepository,
  REALTIME_CLOCK,
  RealtimeClock,
} from "./domain/realtime-ports";
import {
  GpsStreamFrame,
  StreamDecision,
  StreamingPrincipal,
  StreamStatusPayload,
  SubscribeAck,
  TripGuardianAudience,
} from "./domain/realtime.types";
import { StreamingAuthorizationFilter } from "./streaming-authorization.filter";
import {
  isValidTripId,
  TripSubscriptionManager,
} from "./trip-subscription.manager";
import {
  WsHandshakeAuthenticator,
  WsHandshakeError,
} from "./ws-handshake.authenticator";

export interface TelemetryStreamMetrics {
  readonly framesReceived: number;
  readonly framesRejected: number;
  readonly framesWithoutSubscribers: number;
  readonly framesEmitted: number;
  readonly framesThrottled: number;
  readonly framesBlockedByCustody: number;
  readonly audienceErrors: number;
  readonly expiredSessions: number;
  readonly rejectedHandshakes: number;
  readonly overBudgetDispatches: number;
  readonly maxDispatchMs: number;
  readonly connectedSockets: number;
}

/**
 * Pasarela WebSocket Socket.IO del seguimiento en vivo (SRP — Issue #14, RF-10, RNF-02, RNF-05).
 *
 * - Handshake autenticado con JWT (middleware del namespace `/telemetria`): sin token
 *   válido no se establece la conexión (OWASP ASVS V3.2).
 * - Salas segmentadas `trip:{id_viaje}` con validación de rol y parentesco al suscribir.
 * - Consume `telemetry.gps.recorded` (Issue #12) y difunde cada frame socket por socket,
 *   consultando a `StreamingAuthorizationFilter` en el momento de la difusión.
 * - Reconexión: el cliente Socket.IO reconecta solo; el handshake se vuelve a autenticar y
 *   `auth.id_viaje` / `auth.id_viajes` re-suscriben automáticamente sus salas.
 */
@Injectable()
@WebSocketGateway({
  namespace: TELEMETRY_NAMESPACE,
  cors: { origin: true, credentials: true },
})
export class TelemetryGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  private readonly logger = new Logger(TelemetryGateway.name);
  private readonly clock: RealtimeClock;
  private readonly tripQueues = new Map<string, Promise<unknown>>();
  private subscribed = false;

  @WebSocketServer()
  server?: Namespace;

  private metrics = {
    framesReceived: 0,
    framesRejected: 0,
    framesWithoutSubscribers: 0,
    framesEmitted: 0,
    framesThrottled: 0,
    framesBlockedByCustody: 0,
    audienceErrors: 0,
    expiredSessions: 0,
    rejectedHandshakes: 0,
    overBudgetDispatches: 0,
    maxDispatchMs: 0,
  };

  private readonly onGpsRecorded = async (payload: unknown): Promise<void> => {
    // Sin `await`: la difusión no debe frenar el flush de lotes de la ingesta (#12).
    void this.dispatchGpsFrame(payload).catch((err: unknown) => {
      this.logger.error(`Fallo al difundir frame GPS: ${errorMessage(err)}`);
    });
  };

  constructor(
    private readonly authenticator: WsHandshakeAuthenticator,
    private readonly authorization: StreamingAuthorizationFilter,
    private readonly subscriptions: TripSubscriptionManager,
    @Inject(TELEMETRY_EVENT_DISPATCHER)
    private readonly eventDispatcher: IEventDispatcherPort,
    @Inject(GUARDIAN_LINK_REPOSITORY)
    private readonly guardianLinks: IGuardianLinkRepository,
    @Optional() @Inject(REALTIME_CLOCK) clock?: RealtimeClock,
  ) {
    this.clock = clock ?? (() => Date.now());
  }

  onModuleInit(): void {
    if (!this.eventDispatcher.subscribe) {
      this.logger.warn(
        "El despachador de telemetría no admite suscripciones: el stream GPS queda inactivo.",
      );
      return;
    }
    this.eventDispatcher.subscribe(
      TELEMETRY_GPS_RECORDED_EVENT,
      this.onGpsRecorded,
    );
    this.subscribed = true;
  }

  onModuleDestroy(): void {
    const dispatcher = this.eventDispatcher as IEventDispatcherPort & {
      unsubscribe?: (
        name: string,
        handler: (p: unknown) => Promise<void>,
      ) => void;
    };
    if (this.subscribed && dispatcher.unsubscribe) {
      dispatcher.unsubscribe(TELEMETRY_GPS_RECORDED_EVENT, this.onGpsRecorded);
    }
    this.subscribed = false;
  }

  /** Middleware de handshake: rechaza la conexión antes de que exista el socket. */
  afterInit(namespace: Namespace): void {
    namespace.use((socket, next) => {
      this.authenticator
        .authenticate({
          auth: socket.handshake.auth as Record<string, unknown>,
          headers: socket.handshake.headers,
        })
        .then((principal) => {
          (socket.data as { principal?: StreamingPrincipal }).principal =
            principal;
          next();
        })
        .catch((err: unknown) => {
          this.metrics.rejectedHandshakes += 1;
          const code =
            err instanceof WsHandshakeError ? err.code : "TOKEN_INVALID";
          const error = new Error(
            err instanceof Error ? err.message : "Handshake rechazado.",
          ) as Error & { data?: { code: string } };
          error.data = { code };
          next(error);
        });
    });
  }

  async handleConnection(client: Socket): Promise<void> {
    const principal = (client.data as { principal?: StreamingPrincipal })
      .principal;
    if (!principal) {
      client.disconnect(true);
      return;
    }
    this.subscriptions.registerSocket(client.id, principal);

    // Issue #15: el acudiente autenticado entra solo a SU sala familiar.
    if (principal.kind === "GUARDIAN") {
      try {
        const guardianIds = await this.guardianLinks.listGuardianIdsForUser(
          principal.id_usuario,
        );
        for (const idAcudiente of guardianIds) {
          await client.join(familyRoom(idAcudiente));
        }
      } catch (err: unknown) {
        this.logger.error(
          `No se pudo resolver la sala familiar de ${principal.id_usuario}: ${errorMessage(err)}`,
        );
      }
    }

    for (const idViaje of readHandshakeTrips(client.handshake.auth)) {
      const ack = await this.subscribeToTrip(client, idViaje);
      client.emit(SERVER_EVENTS.STREAM_STATUS, this.toStatus(idViaje, ack));
    }
  }

  handleDisconnect(client: Socket): void {
    this.subscriptions.unregisterSocket(client.id);
  }

  @SubscribeMessage(CLIENT_EVENTS.SUBSCRIBE)
  async handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { id_viaje?: unknown },
  ): Promise<SubscribeAck> {
    return this.subscribeToTrip(client, payload?.id_viaje);
  }

  @SubscribeMessage(CLIENT_EVENTS.UNSUBSCRIBE)
  async handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { id_viaje?: unknown },
  ): Promise<{ unsubscribed: boolean }> {
    if (!isValidTripId(payload?.id_viaje)) {
      return { unsubscribed: false };
    }
    const idViaje = payload.id_viaje.trim().toLowerCase();
    this.subscriptions.removeTrip(client.id, idViaje);
    await client.leave(tripRoom(idViaje));
    return { unsubscribed: true };
  }

  /** Difusión de un frame `telemetry.gps.recorded`; serializada por viaje. */
  async dispatchGpsFrame(payload: unknown): Promise<void> {
    this.metrics.framesReceived += 1;
    const frame = parseGpsFrame(payload);
    if (!frame) {
      this.metrics.framesRejected += 1;
      return;
    }

    const previous = this.tripQueues.get(frame.id_viaje) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.broadcastFrame(frame));
    this.tripQueues.set(frame.id_viaje, current);
    void current.finally(() => {
      if (this.tripQueues.get(frame.id_viaje) === current) {
        this.tripQueues.delete(frame.id_viaje);
      }
    });
    await current;
  }

  getMetrics(): TelemetryStreamMetrics {
    return {
      ...this.metrics,
      maxDispatchMs: Number(this.metrics.maxDispatchMs.toFixed(3)),
      connectedSockets: this.subscriptions.countSockets(),
    };
  }

  private async subscribeToTrip(
    client: Socket,
    rawTripId: unknown,
  ): Promise<SubscribeAck> {
    const principal = this.activePrincipal(client);
    if (!principal) {
      return rejectedAck("SIN_VINCULO_CON_VIAJE");
    }
    if (!isValidTripId(rawTripId)) {
      return rejectedAck("ID_VIAJE_INVALIDO");
    }
    const idViaje = rawTripId.trim().toLowerCase();

    let decision: StreamDecision;
    try {
      decision = await this.authorization.decideForTrip(principal, idViaje);
    } catch (err: unknown) {
      this.logger.error(
        `No se pudo autorizar la suscripción a ${tripRoom(idViaje)}: ${errorMessage(err)}`,
      );
      return rejectedAck("SIN_VINCULO_CON_VIAJE");
    }

    // RNF-02: un acudiente sin hijos inscritos en el viaje no puede unirse a la sala.
    if (decision.reason === "SIN_VINCULO_CON_VIAJE") {
      return rejectedAck("SIN_VINCULO_CON_VIAJE");
    }

    const added = this.subscriptions.addTrip(
      client.id,
      idViaje,
      decision.allowed,
    );
    if (added === "LIMIT_REACHED") {
      return rejectedAck("LIMITE_SUSCRIPCIONES");
    }
    await client.join(tripRoom(idViaje));

    return {
      subscribed: true,
      room: tripRoom(idViaje),
      transmitiendo: decision.allowed,
      motivo: decision.reason,
      estudiantes: decision.estudiantes,
    };
  }

  private async broadcastFrame(frame: GpsStreamFrame): Promise<void> {
    const server = this.server;
    const room = tripRoom(frame.id_viaje);
    const socketIds = server?.adapter.rooms.get(room);
    if (!server || !socketIds || socketIds.size === 0) {
      this.metrics.framesWithoutSubscribers += 1;
      return;
    }

    const startedAt = performance.now();
    const sockets = Array.from(socketIds)
      .map((id) => server.sockets.get(id))
      .filter((s): s is Socket => s !== undefined);

    const hasGuardians = sockets.some(
      (s) => this.subscriptions.getPrincipal(s.id)?.kind === "GUARDIAN",
    );
    let audience: TripGuardianAudience | null = new Map();
    if (hasGuardians) {
      try {
        audience = await this.authorization.resolveTripAudience(frame.id_viaje);
      } catch (err: unknown) {
        // Fail-closed: sin certeza del estado de custodia no se emite a acudientes.
        audience = null;
        this.metrics.audienceErrors += 1;
        this.logger.error(
          `No se pudo resolver la audiencia de ${room}: ${errorMessage(err)}`,
        );
      }
    }

    const nowMs = this.clock();
    for (const socket of sockets) {
      const principal = this.activePrincipal(socket);
      if (!principal) {
        continue;
      }
      if (principal.kind === "GUARDIAN" && audience === null) {
        this.metrics.framesBlockedByCustody += 1;
        continue;
      }

      const decision = this.authorization.decide(
        principal,
        audience ?? new Map(),
      );
      if (
        this.subscriptions.updateTransmitting(
          socket.id,
          frame.id_viaje,
          decision.allowed,
        )
      ) {
        socket.emit(SERVER_EVENTS.STREAM_STATUS, {
          id_viaje: frame.id_viaje,
          suscrito: decision.reason !== "SIN_VINCULO_CON_VIAJE",
          transmitiendo: decision.allowed,
          motivo: decision.reason,
          estudiantes: decision.estudiantes,
          fecha_hora: new Date(nowMs).toISOString(),
        } satisfies StreamStatusPayload);
      }

      if (!decision.allowed) {
        this.metrics.framesBlockedByCustody += 1;
        if (decision.reason === "SIN_VINCULO_CON_VIAJE") {
          this.subscriptions.removeTrip(socket.id, frame.id_viaje);
          void socket.leave(room);
        }
        continue;
      }

      if (
        !this.subscriptions.tryAcquireEmitSlot(socket.id, frame.id_viaje, nowMs)
      ) {
        this.metrics.framesThrottled += 1;
        continue;
      }
      socket.emit(SERVER_EVENTS.GPS, frame);
      this.metrics.framesEmitted += 1;
    }

    const dispatchMs = performance.now() - startedAt;
    this.metrics.maxDispatchMs = Math.max(
      this.metrics.maxDispatchMs,
      dispatchMs,
    );
    if (dispatchMs >= GPS_DISPATCH_LATENCY_BUDGET_MS) {
      this.metrics.overBudgetDispatches += 1;
      this.logger.warn(
        `Difusión de ${room} tardó ${dispatchMs.toFixed(1)} ms (DoD #14: < ${GPS_DISPATCH_LATENCY_BUDGET_MS} ms).`,
      );
    }
  }

  /** Autorización por mensaje: cierra el socket si el Access Token ya venció. */
  private activePrincipal(socket: Socket): StreamingPrincipal | null {
    const principal = this.subscriptions.getPrincipal(socket.id);
    if (!principal) {
      return null;
    }
    if (this.clock() >= principal.expiresAtMs) {
      this.metrics.expiredSessions += 1;
      socket.emit(SERVER_EVENTS.AUTH_EXPIRED, {
        motivo: "TOKEN_EXPIRADO",
        mensaje: "La sesión expiró: reconecte con un Access Token vigente.",
      });
      this.subscriptions.unregisterSocket(socket.id);
      socket.disconnect(true);
      return null;
    }
    return principal;
  }

  private toStatus(idViaje: unknown, ack: SubscribeAck): StreamStatusPayload {
    return {
      id_viaje:
        typeof idViaje === "string" ? idViaje.trim().toLowerCase() : null,
      suscrito: ack.subscribed,
      transmitiendo: ack.transmitiendo,
      motivo: ack.motivo,
      estudiantes: ack.estudiantes,
      fecha_hora: new Date(this.clock()).toISOString(),
    };
  }
}

function rejectedAck(motivo: SubscribeAck["motivo"]): SubscribeAck {
  return {
    subscribed: false,
    room: null,
    transmitiendo: false,
    motivo,
    estudiantes: [],
  };
}

function readHandshakeTrips(auth: unknown): string[] {
  if (!auth || typeof auth !== "object") {
    return [];
  }
  const a = auth as { id_viaje?: unknown; id_viajes?: unknown };
  const raw = Array.isArray(a.id_viajes)
    ? a.id_viajes
    : a.id_viaje !== undefined
      ? [a.id_viaje]
      : [];
  return raw
    .filter((v): v is string => typeof v === "string")
    .slice(0, MAX_TRIP_SUBSCRIPTIONS_PER_SOCKET);
}

/** Valida el evento de ingesta y conserva solo los campos públicos del frame. */
export function parseGpsFrame(payload: unknown): GpsStreamFrame | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const p = payload as Record<string, unknown>;
  const finite = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v);
  if (
    !isValidTripId(p.id_viaje) ||
    typeof p.id_vehiculo !== "string" ||
    !finite(p.latitud) ||
    p.latitud < -90 ||
    p.latitud > 90 ||
    !finite(p.longitud) ||
    p.longitud < -180 ||
    p.longitud > 180 ||
    !finite(p.velocidad_kmh) ||
    typeof p.fecha_hora !== "string" ||
    Number.isNaN(Date.parse(p.fecha_hora))
  ) {
    return null;
  }
  return {
    id_viaje: p.id_viaje.trim().toLowerCase(),
    id_vehiculo: p.id_vehiculo,
    placa: typeof p.placa === "string" ? p.placa : "",
    latitud: p.latitud,
    longitud: p.longitud,
    velocidad_kmh: p.velocidad_kmh,
    rumbo_grados: finite(p.rumbo_grados) ? p.rumbo_grados : null,
    fecha_hora: p.fecha_hora,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
