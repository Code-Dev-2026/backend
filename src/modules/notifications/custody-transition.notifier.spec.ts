import {
  CustodyHistoryRecord,
  FsmCustodyState,
} from "../custody/domain/custody.types";
import { CustodyTransitionNotifier } from "./custody-transition.notifier";
import { InMemoryNotificationRepository } from "./infrastructure/in-memory-notification.repository";
import { InMemoryNotificationRecipientDirectory } from "./infrastructure/notification-recipient.directory";
import { NotificationChannelRegistry } from "./notification-channel.registry";
import { NotificationDispatcherService } from "./notification-dispatcher.service";

const STUDENT = "018e38d9-3f00-7200-a000-00000000d101";
const MOTHER = "018e38d9-3f00-7200-a000-00000000d201";
const FATHER = "018e38d9-3f00-7200-a000-00000000d202";

const history = (
  estado_origen: FsmCustodyState,
  estado_destino: FsmCustodyState,
  id = "018e38d9-3f00-7200-a000-00000000d301",
): CustodyHistoryRecord => ({
  id_historial: id,
  secuencia: 1,
  id_estudiante: STUDENT,
  id_viaje: "018e38d9-3f00-7200-a000-00000000d401",
  estado_origen,
  estado_destino,
  disparador_evento: "PRUEBA",
  coordenadas_gps: null,
  fecha_hora: new Date(),
  registrado_por_usuario: null,
  hash_sha256_anterior: "0".repeat(64),
  hash_sha256_actual: "1".repeat(64),
});

describe("CustodyTransitionNotifier (Issue #15 — RF-20)", () => {
  let repository: InMemoryNotificationRepository;
  let directory: InMemoryNotificationRecipientDirectory;
  let notifier: CustodyTransitionNotifier;

  beforeEach(() => {
    repository = new InMemoryNotificationRepository();
    directory = new InMemoryNotificationRecipientDirectory();
    directory.registerGuardian(STUDENT, MOTHER);
    directory.registerGuardian(STUDENT, FATHER);
    const registry = new NotificationChannelRegistry();
    registry.register({
      name: "ws",
      deliver: async () => ({ channel: "ws", status: "DELIVERED" }),
    });
    notifier = new CustodyTransitionNotifier(
      new NotificationDispatcherService(repository, registry, {
        retryBackoffMs: [1],
      }),
      directory,
    );
  });

  it.each([
    [
      FsmCustodyState.NO_INICIADO,
      FsmCustodyState.EN_ESPERA_ABORDAJE,
      "PROXIMIDAD_PARADA",
    ],
    [
      FsmCustodyState.EN_ESPERA_ABORDAJE,
      FsmCustodyState.A_BORDO_VEHICULO,
      "ABORDAJE_EXITOSO",
    ],
    [
      FsmCustodyState.A_BORDO_VEHICULO,
      FsmCustodyState.ENTREGADO_ACUDIENTE,
      "DESCENSO_EXITOSO",
    ],
    [
      FsmCustodyState.A_BORDO_VEHICULO,
      FsmCustodyState.EN_COLEGIO,
      "DESCENSO_EXITOSO",
    ],
    [
      FsmCustodyState.A_BORDO_VEHICULO,
      FsmCustodyState.RETORNO_SEDE_POR_FALLA_ENTREGA,
      "INCIDENTE_ENTREGA",
    ],
  ])(
    "clasifica %s → %s como %s y notifica a cada acudiente legitimado",
    async (from, to, codigo) => {
      const outcomes = await notifier.notifyTransition(history(from, to));

      expect(outcomes.map((o) => o.status)).toEqual(["ENTREGADA", "ENTREGADA"]);
      const rows = repository.listAll();
      expect(rows.map((r) => r.id_acudiente).sort()).toEqual(
        [MOTHER, FATHER].sort(),
      );
      expect(rows.every((r) => r.codigo_tipo === codigo)).toBe(true);
      expect(rows[0].payload_adicional.estado_custodia).toBe(to);
    },
  );

  it("usa una clave idempotente por evento de historial y acudiente", async () => {
    const h = history(
      FsmCustodyState.EN_ESPERA_ABORDAJE,
      FsmCustodyState.A_BORDO_VEHICULO,
    );
    await notifier.notifyTransition(h);
    await notifier.notifyTransition(h);
    expect(
      repository
        .listAll()
        .map((r) => r.idempotency_key)
        .sort(),
    ).toEqual(
      [
        `transicion:${h.id_historial}:${FATHER}`,
        `transicion:${h.id_historial}:${MOTHER}`,
      ].sort(),
    );
  });

  it("no notifica estados sin plantilla ni estudiantes sin acudientes", async () => {
    await expect(
      notifier.notifyTransition(
        history(FsmCustodyState.NO_INICIADO, FsmCustodyState.NO_INICIADO),
      ),
    ).resolves.toEqual([]);
    const orphan = {
      ...history(
        FsmCustodyState.NO_INICIADO,
        FsmCustodyState.EN_ESPERA_ABORDAJE,
      ),
      id_estudiante: "otro",
    };
    await expect(notifier.notifyTransition(orphan)).resolves.toEqual([]);
    expect(repository.listAll()).toEqual([]);
  });
});
