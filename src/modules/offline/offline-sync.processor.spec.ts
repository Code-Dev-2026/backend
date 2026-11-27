import {
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { AuthenticatedUser } from "@common/decorators/current-user.decorator";
import {
  IOfflineOperationHandler,
  OfflineHandlerContext,
  OfflineHandlerResult,
} from "./domain/offline-sync.ports";
import {
  OfflineOperationInput,
  OfflineOperationType,
} from "./domain/offline-sync.types";
import {
  InMemoryDeviceRegistry,
  InMemorySyncOperationRepository,
} from "./infrastructure/in-memory-offline-sync.repositories";
import { OfflineSyncProcessor } from "./offline-sync.processor";

const DEVICE = "018e38d9-3f00-7200-a000-0000000d0001";
const MONITORA: AuthenticatedUser = {
  id_usuario: "018e38d9-3f00-7200-a000-0000000a0001",
  email: "monitora@test.co",
  roles: ["MONITORA"],
};
const NOW = Date.parse("2026-11-27T15:00:00.000Z");

class RecordingHandler implements IOfflineOperationHandler {
  readonly entidad_afectada: string;
  readonly camposSensibles = ["qr_token"];
  readonly calls: Array<{
    datos: Record<string, unknown>;
    ctx: OfflineHandlerContext;
  }> = [];
  behavior: (datos: Record<string, unknown>) => Promise<OfflineHandlerResult> =
    async () => ({
      kind: "APPLIED",
      conflicto: false,
      codigo: "OK",
      resultado: { aplicado: true },
    });

  constructor(readonly tipo: OfflineOperationType) {
    this.entidad_afectada =
      tipo === "ABORDAJE" ? "registro_de_asistencia" : "entrega";
  }

  async execute(datos: Record<string, unknown>, ctx: OfflineHandlerContext) {
    this.calls.push({ datos, ctx });
    return this.behavior(datos);
  }
}

const op = (
  key: string,
  minutesAgo: number,
  tipo: OfflineOperationType = "ABORDAJE",
  datos: Record<string, unknown> = { qr_token: `QR-${key}` },
): OfflineOperationInput => ({
  idempotency_key: key,
  tipo,
  fecha_cliente: new Date(NOW - minutesAgo * 60_000).toISOString(),
  datos,
});

describe("OfflineSyncProcessor (Issue #16 — RF-08, RNF-04, ASVS V11.1)", () => {
  let repository: InMemorySyncOperationRepository;
  let devices: InMemoryDeviceRegistry;
  let boarding: RecordingHandler;
  let disembark: RecordingHandler;
  let processor: OfflineSyncProcessor;

  beforeEach(() => {
    repository = new InMemorySyncOperationRepository();
    devices = new InMemoryDeviceRegistry();
    devices.registerDevice({
      id_dispositivo: DEVICE,
      id_usuario: MONITORA.id_usuario,
      activo: true,
    });
    boarding = new RecordingHandler("ABORDAJE");
    disembark = new RecordingHandler("DESCENSO");
    processor = new OfflineSyncProcessor(
      repository,
      devices,
      [boarding, disembark],
      () => NOW,
    );
  });

  it("criterio de aceptación: 5 registros retransmitidos dos veces → éxito en ambas sin duplicar", async () => {
    const batch = {
      id_dispositivo: DEVICE,
      operaciones: [1, 2, 3, 4, 5].map((n) => op(`scan-000${n}`, 60 - n)),
    };

    const first = await processor.processBatch(MONITORA, batch);
    const second = await processor.processBatch(MONITORA, batch);

    expect(first).toMatchObject({ total: 5, procesadas: 5, duplicadas: 0 });
    expect(second).toMatchObject({ total: 5, procesadas: 0, duplicadas: 5 });
    expect(
      second.operaciones.every((o) => o.estado === "PROCESADO" && o.duplicado),
    ).toBe(true);
    expect(second.operaciones.map((o) => o.id_sync)).toEqual(
      first.operaciones.map((o) => o.id_sync),
    );
    expect(boarding.calls).toHaveLength(5);
    expect(repository.listAll()).toHaveLength(5);
  });

  it("aplica las operaciones en orden cronológico de fecha_cliente", async () => {
    const report = await processor.processBatch(MONITORA, {
      id_dispositivo: DEVICE,
      operaciones: [
        op("desc-0001", 5, "DESCENSO", { id_estudiante: "e1" }),
        op("abor-0001", 30, "ABORDAJE", { qr_token: "QR-e1" }),
        op("abor-0002", 20, "ABORDAJE", { qr_token: "QR-e2" }),
      ],
    });

    expect(report.operaciones.map((o) => o.idempotency_key)).toEqual([
      "abor-0001",
      "abor-0002",
      "desc-0001",
    ]);
    expect(report.operaciones.map((o) => o.orden_aplicacion)).toEqual([
      1, 2, 3,
    ]);
    expect(boarding.calls.map((c) => c.datos.qr_token)).toEqual([
      "QR-e1",
      "QR-e2",
    ]);
  });

  it("propaga una clave idempotente por dispositivo al caso de uso (segunda barrera)", async () => {
    await processor.processBatch(MONITORA, {
      id_dispositivo: DEVICE,
      operaciones: [op("scan-key1", 1)],
    });
    expect(boarding.calls[0].ctx).toMatchObject({
      idempotency_key: `offline:${DEVICE}:scan-key1`,
      id_dispositivo: DEVICE,
      user: MONITORA,
    });
  });

  it.each([
    ["no registrado", "018e38d9-3f00-7200-a000-0000000dffff", MONITORA],
    ["de otra monitora", DEVICE, { ...MONITORA, id_usuario: "otra" }],
  ])("rechaza un dispositivo %s (403)", async (_l, idDispositivo, user) => {
    await expect(
      processor.processBatch(user, {
        id_dispositivo: idDispositivo,
        operaciones: [op("scan-0001", 1)],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(boarding.calls).toEqual([]);
    expect(repository.listAll()).toEqual([]);
  });

  it("rechaza un dispositivo inactivo (403)", async () => {
    devices.registerDevice({
      id_dispositivo: DEVICE,
      id_usuario: MONITORA.id_usuario,
      activo: false,
    });
    await expect(
      processor.processBatch(MONITORA, {
        id_dispositivo: DEVICE,
        operaciones: [op("scan-0001", 1)],
      }),
    ).rejects.toMatchObject({
      response: { code: "DISPOSITIVO_NO_AUTORIZADO" },
    });
  });

  it.each([
    ["pasada (> 24 h)", 24 * 60 + 1],
    ["futura (> 24 h)", -(24 * 60 + 1)],
  ])(
    "descarta y audita eventos con fecha %s sin ejecutarlos",
    async (_l, minutesAgo) => {
      const report = await processor.processBatch(MONITORA, {
        id_dispositivo: DEVICE,
        operaciones: [op("skew-0001", minutesAgo)],
      });
      expect(report.operaciones[0]).toMatchObject({
        estado: "DESCARTADO",
        codigo: "DESFASE_TEMPORAL",
      });
      expect(boarding.calls).toEqual([]);
      expect(repository.listAll()[0].estado_sync).toBe("DESCARTADO");
    },
  );

  it("acepta ráfagas diferidas dentro de las 24 h", async () => {
    const report = await processor.processBatch(MONITORA, {
      id_dispositivo: DEVICE,
      operaciones: [op("late-0001", 23 * 60 + 59)],
    });
    expect(report.operaciones[0].estado).toBe("PROCESADO");
  });

  it("deduplica claves repetidas dentro del mismo lote", async () => {
    const report = await processor.processBatch(MONITORA, {
      id_dispositivo: DEVICE,
      operaciones: [op("same-0001", 3), op("same-0001", 2)],
    });
    expect(boarding.calls).toHaveLength(1);
    expect(report).toMatchObject({ procesadas: 1, duplicadas: 1 });
  });

  it("marca DESCARTADO un payload inválido y no lo re-ejecuta al retransmitir", async () => {
    boarding.behavior = async () => ({
      kind: "INVALID",
      errores: ["id_viaje: must be a UUID"],
    });
    const batch = { id_dispositivo: DEVICE, operaciones: [op("bad-00001", 1)] };

    const first = await processor.processBatch(MONITORA, batch);
    const second = await processor.processBatch(MONITORA, batch);

    expect(first.operaciones[0]).toMatchObject({
      estado: "DESCARTADO",
      codigo: "PAYLOAD_INVALIDO",
      resultado: expect.objectContaining({
        errores: ["id_viaje: must be a UUID"],
      }),
    });
    expect(second.operaciones[0]).toMatchObject({
      estado: "DESCARTADO",
      duplicado: true,
    });
    expect(boarding.calls).toHaveLength(1);
  });

  it("registra CONFLICTO ante rechazos de negocio (4xx) sin abortar el resto del lote", async () => {
    boarding.behavior = async (datos) => {
      if (datos.qr_token === "QR-conf-0001") {
        throw new ConflictException({
          code: "TRIP_NOT_IN_PROGRESS",
          message: "Viaje no EN_CURSO",
        });
      }
      return {
        kind: "APPLIED",
        conflicto: false,
        codigo: "ABORDAJE_EXITOSO",
        resultado: {},
      };
    };

    const report = await processor.processBatch(MONITORA, {
      id_dispositivo: DEVICE,
      operaciones: [op("conf-0001", 2), op("okay-0001", 1)],
    });

    expect(report.operaciones[0]).toMatchObject({
      estado: "CONFLICTO",
      codigo: "TRIP_NOT_IN_PROGRESS",
      resultado: expect.objectContaining({ http_status: 409 }),
    });
    expect(report.operaciones[1]).toMatchObject({
      estado: "PROCESADO",
      codigo: "ABORDAJE_EXITOSO",
    });
    expect(report).toMatchObject({ conflictos: 1, procesadas: 1 });
  });

  it("registra CONFLICTO cuando el caso de uso responde aprobado=false (p. ej. sobrecupo)", async () => {
    boarding.behavior = async () => ({
      kind: "APPLIED",
      conflicto: true,
      codigo: "DENEGADO_SOBRECUPO",
      resultado: { aprobado: false },
    });
    const report = await processor.processBatch(MONITORA, {
      id_dispositivo: DEVICE,
      operaciones: [op("full-0001", 1)],
    });
    expect(report.operaciones[0]).toMatchObject({
      estado: "CONFLICTO",
      codigo: "DENEGADO_SOBRECUPO",
    });
  });

  it("compensación: un error transitorio deja la fila PENDIENTE y el reintento la completa", async () => {
    boarding.behavior = async () => {
      throw new ServiceUnavailableException("BD no disponible");
    };
    const batch = { id_dispositivo: DEVICE, operaciones: [op("tran-0001", 1)] };

    const first = await processor.processBatch(MONITORA, batch);
    expect(first.operaciones[0]).toMatchObject({
      estado: "ERROR_TRANSITORIO",
      codigo: "REINTENTAR",
    });
    expect(first.errores_transitorios).toBe(1);
    expect(repository.listAll()[0].estado_sync).toBe("PENDIENTE");

    boarding.behavior = async () => ({
      kind: "APPLIED",
      conflicto: false,
      codigo: "ABORDAJE_EXITOSO",
      resultado: {},
    });
    const retry = await processor.processBatch(MONITORA, batch);

    expect(retry.operaciones[0]).toMatchObject({
      estado: "PROCESADO",
      duplicado: false,
    });
    expect(boarding.calls.map((c) => c.ctx.idempotency_key)).toEqual([
      `offline:${DEVICE}:tran-0001`,
      `offline:${DEVICE}:tran-0001`,
    ]);
    expect(repository.listAll()).toHaveLength(1);
  });

  it("no guarda en claro datos sensibles en sync_operation (Ley 1581)", async () => {
    await processor.processBatch(MONITORA, {
      id_dispositivo: DEVICE,
      operaciones: [
        op("priv-0001", 1, "ABORDAJE", {
          qr_token: "QR-SECRETO",
          id_viaje: "v",
        }),
      ],
    });
    const stored = repository.listAll()[0].payload_json as {
      datos: Record<string, unknown>;
    };
    expect(stored.datos).toEqual({ qr_token: "[REDACTADO]", id_viaje: "v" });
    // El caso de uso sí recibe el valor real.
    expect(boarding.calls[0].datos.qr_token).toBe("QR-SECRETO");
  });

  it("serializa retransmisiones simultáneas del mismo dispositivo", async () => {
    boarding.behavior = async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { kind: "APPLIED", conflicto: false, codigo: "OK", resultado: {} };
    };
    const batch = {
      id_dispositivo: DEVICE,
      operaciones: [1, 2, 3, 4, 5].map((n) => op(`para-000${n}`, n)),
    };

    const [a, b] = await Promise.all([
      processor.processBatch(MONITORA, batch),
      processor.processBatch(MONITORA, batch),
    ]);

    expect(boarding.calls).toHaveLength(5);
    expect(a.procesadas + b.procesadas).toBe(5);
    expect(a.duplicadas + b.duplicadas).toBe(5);
  });

  it("procesa una ráfaga máxima de 100 operaciones en orden", async () => {
    const operaciones = Array.from({ length: 100 }, (_, i) =>
      op(`burst-${String(i).padStart(4, "0")}`, 100 - i),
    );
    const report = await processor.processBatch(MONITORA, {
      id_dispositivo: DEVICE,
      operaciones,
    });
    expect(report).toMatchObject({ total: 100, procesadas: 100 });
    expect(boarding.calls.map((c) => c.datos.qr_token)).toEqual(
      operaciones.map((o) => o.datos.qr_token),
    );
  });
});
