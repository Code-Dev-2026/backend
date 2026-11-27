import {
  INotificationChannelPort,
  NOTIFICATION_LATENCY_BUDGET_MS,
} from "./domain/notification-dispatch.ports";
import {
  ChannelDeliveryResult,
  ChannelDeliveryStatus,
  DispatchNotificationCommand,
  OutboundNotification,
} from "./domain/notification-dispatch.types";
import { InMemoryNotificationRepository } from "./infrastructure/in-memory-notification.repository";
import { NotificationChannelRegistry } from "./notification-channel.registry";
import { NotificationDispatcherService } from "./notification-dispatcher.service";

/** Mock del canal WebSocket: responde con la secuencia de estados configurada. */
class MockSocketChannel implements INotificationChannelPort {
  readonly delivered: OutboundNotification[] = [];
  active = 0;
  maxActive = 0;

  constructor(
    readonly name: string,
    private readonly script:
      ChannelDeliveryStatus[] | (() => ChannelDeliveryStatus),
    private readonly delayMs = 0,
  ) {}

  async deliver(n: OutboundNotification): Promise<ChannelDeliveryResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
    this.active -= 1;
    this.delivered.push(n);
    const status =
      typeof this.script === "function"
        ? this.script()
        : (this.script.shift() ?? "NO_RECIPIENT");
    return {
      channel: this.name,
      status,
      detail: status === "DELIVERED" ? undefined : "mock",
    };
  }
}

const command = (
  key: string,
  overrides: Partial<DispatchNotificationCommand> = {},
): DispatchNotificationCommand => ({
  idempotency_key: key,
  codigo_tipo: "ABORDAJE_EXITOSO",
  id_acudiente: "018e38d9-3f00-7200-a000-00000000c001",
  id_estudiante: "018e38d9-3f00-7200-a000-00000000c101",
  id_viaje: "018e38d9-3f00-7200-a000-00000000c201",
  titulo: "Abordaje confirmado",
  mensaje: "El estudiante ha subido al vehículo escolar.",
  payload: { estado_custodia: "A_BORDO_VEHICULO" },
  ocurrido_en: new Date(),
  ...overrides,
});

describe("NotificationDispatcherService (Issue #15 — RF-12, RF-20, RNF-05)", () => {
  let repository: InMemoryNotificationRepository;
  let registry: NotificationChannelRegistry;
  let dispatcher: NotificationDispatcherService;

  const build = (options = {}) => {
    dispatcher = new NotificationDispatcherService(repository, registry, {
      retryBackoffMs: [5, 5],
      ...options,
    });
  };

  beforeEach(() => {
    repository = new InMemoryNotificationRepository();
    registry = new NotificationChannelRegistry();
    build();
  });

  it("persiste en notificacion y la marca ENTREGADA con la confirmación del cliente, en < 2,5 s", async () => {
    const socket = new MockSocketChannel("ws", ["DELIVERED"]);
    registry.register(socket);

    const outcome = await dispatcher.enqueue(command("abordaje:v:e"));

    expect(outcome).toMatchObject({ status: "ENTREGADA", intentos: 1 });
    expect(outcome.latencia_ms).toBeLessThan(NOTIFICATION_LATENCY_BUDGET_MS);
    const stored = repository.findByIdempotencyKey("abordaje:v:e")!;
    expect(stored).toMatchObject({
      codigo_tipo: "ABORDAJE_EXITOSO",
      canal: "PUSH",
      estado_envio: "ENTREGADA",
      intentos_realizados: 1,
      ultimo_error: null,
    });
    expect(stored.entregada_en).toBeInstanceOf(Date);
    expect(socket.delivered[0]).toMatchObject({
      id_notificacion: stored.id_notificacion,
      intento: 1,
      codigo_tipo: "ABORDAJE_EXITOSO",
    });
  });

  it("es idempotente por idempotency_key: no duplica filas ni reenvía lo ya entregado", async () => {
    const socket = new MockSocketChannel("ws", () => "DELIVERED");
    registry.register(socket);

    await dispatcher.enqueue(command("descenso:x:a"));
    const second = await dispatcher.enqueue(command("descenso:x:a"));

    expect(second.status).toBe("YA_ENTREGADA");
    expect(repository.listAll()).toHaveLength(1);
    expect(socket.delivered).toHaveLength(1);
    expect(dispatcher.getMetrics().duplicatesSkipped).toBe(1);
  });

  it("reutiliza la fila creada previamente (p. ej. por V015/V016) y conserva su id", async () => {
    registry.register(new MockSocketChannel("ws", ["DELIVERED"]));
    const preexisting = await repository.upsertPending(
      command("abordaje:v:e", {
        id_notificacion: "018e38d9-3f00-7200-a000-00000000c999",
      }),
    );

    const outcome = await dispatcher.enqueue(command("abordaje:v:e"));

    expect(outcome.id_notificacion).toBe(
      preexisting.notification.id_notificacion,
    );
    expect(repository.listAll()).toHaveLength(1);
  });

  it("reintenta sin sesión activa y entrega cuando el acudiente se conecta", async () => {
    const socket = new MockSocketChannel("ws", ["NO_RECIPIENT", "DELIVERED"]);
    registry.register(socket);

    const outcome = await dispatcher.enqueue(command("k-retry"));

    expect(outcome).toMatchObject({ status: "ENTREGADA", intentos: 2 });
    expect(socket.delivered.map((d) => d.intento)).toEqual([1, 2]);
    expect(dispatcher.getMetrics().retries).toBe(1);
  });

  it("marca FALLIDA tras max_intentos (3) sin confirmación y registra el último error", async () => {
    registry.register(new MockSocketChannel("ws", () => "NO_RECIPIENT"));

    const outcome = await dispatcher.enqueue(command("k-fail"));

    expect(outcome).toMatchObject({ status: "FALLIDA", intentos: 3 });
    const stored = repository.findByIdempotencyKey("k-fail")!;
    expect(stored.estado_envio).toBe("FALLIDA");
    expect(stored.intentos_realizados).toBe(3);
    expect(stored.ultimo_error).toContain("ws:NO_RECIPIENT");
  });

  it("registra ENVIADA cuando hubo emisión sin ack y luego ENTREGADA al confirmar", async () => {
    const socket = new MockSocketChannel("ws", [
      "SENT_UNCONFIRMED",
      "DELIVERED",
    ]);
    registry.register(socket);
    const states: string[] = [];
    const original = repository.recordAttempt.bind(repository);
    jest
      .spyOn(repository, "recordAttempt")
      .mockImplementation(async (id, input) => {
        states.push(input.estado_envio);
        return original(id, input);
      });

    await dispatcher.enqueue(command("k-sent"));

    expect(states).toEqual(["ENVIADA", "ENTREGADA"]);
    expect(
      repository.findByIdempotencyKey("k-sent")!.despachada_en,
    ).toBeInstanceOf(Date);
  });

  it("aísla canales que fallan con excepción (OCP: basta con que uno confirme)", async () => {
    const broken: INotificationChannelPort = {
      name: "roto",
      deliver: jest.fn().mockRejectedValue(new Error("socket caído")),
    };
    registry.register(broken);
    registry.register(new MockSocketChannel("ws", ["DELIVERED"]));

    await expect(dispatcher.enqueue(command("k-ocp"))).resolves.toMatchObject({
      status: "ENTREGADA",
    });
  });

  it("deja la fila PENDIENTE si no hay canales registrados", async () => {
    const outcome = await dispatcher.enqueue(command("k-none"));
    expect(outcome.status).toBe("SIN_CANALES");
    expect(repository.findByIdempotencyKey("k-none")!.estado_envio).toBe(
      "PENDIENTE",
    );
  });

  it("reporta ERROR_PERSISTENCIA sin emitir si no se pudo guardar la notificación", async () => {
    const socket = new MockSocketChannel("ws", ["DELIVERED"]);
    registry.register(socket);
    jest
      .spyOn(repository, "upsertPending")
      .mockRejectedValueOnce(new Error("db down"));

    const outcome = await dispatcher.enqueue(command("k-db"));

    expect(outcome.status).toBe("ERROR_PERSISTENCIA");
    expect(socket.delivered).toEqual([]);
    expect(dispatcher.getMetrics().persistenceErrors).toBe(1);
  });

  it("cola no bloqueante con concurrencia acotada en hora pico (300 eventos)", async () => {
    build({ maxConcurrency: 10 });
    const socket = new MockSocketChannel("ws", () => "DELIVERED", 2);
    registry.register(socket);

    const started = Date.now();
    const promises = Array.from({ length: 300 }, (_, i) =>
      dispatcher.enqueue(command(`peak-${i}`)),
    );
    // `enqueue` retorna de inmediato: el caso de uso no espera el despacho.
    expect(Date.now() - started).toBeLessThan(50);
    expect(
      dispatcher.getMetrics().queued + dispatcher.getMetrics().inFlight,
    ).toBe(300);

    const outcomes = await Promise.all(promises);
    await dispatcher.drain();

    expect(outcomes.every((o) => o.status === "ENTREGADA")).toBe(true);
    expect(socket.maxActive).toBeLessThanOrEqual(10);
    expect(repository.listAll()).toHaveLength(300);
    expect(dispatcher.getMetrics().overBudget).toBe(0);
  });
});
