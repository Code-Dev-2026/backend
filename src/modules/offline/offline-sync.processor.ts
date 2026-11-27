import {
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from "@nestjs/common";
import { AuthenticatedUser } from "@common/decorators/current-user.decorator";
import {
  DEVICE_REGISTRY,
  IDeviceRegistry,
  IOfflineOperationHandler,
  ISyncOperationRepository,
  MAX_CLIENT_CLOCK_SKEW_MS,
  OFFLINE_OPERATION_HANDLERS,
  OFFLINE_SYNC_CLOCK,
  OfflineSyncClock,
  SYNC_OPERATION_REPOSITORY,
} from "./domain/offline-sync.ports";
import {
  OfflineOperationInput,
  OfflineOperationReport,
  OfflineSyncBatchInput,
  OfflineSyncBatchReport,
  StoredSyncOperation,
  SyncOperationState,
} from "./domain/offline-sync.types";

const REDACTED = "[REDACTADO]";

/**
 * Procesador transaccional de sincronización offline idempotente (Issue #16 — SRP).
 *
 * Solo deserializa, ordena y coordina la idempotencia; las reglas de negocio las
 * ejecutan los casos de uso de abordaje (#8) y descenso (#9) a través de los
 * `IOfflineOperationHandler` registrados.
 *
 * Por operación, en orden cronológico de `fecha_cliente`:
 * 1. Reserva `(id_dispositivo, idempotency_key)` en `sync_operation` (PENDIENTE). Si ya
 *    existía con resultado final, responde ese resultado como duplicado sin re-ejecutar.
 * 2. Descarta eventos con desfase > 24 h respecto al reloj del servidor (ASVS V11.1).
 * 3. Delega al caso de uso con la misma clave idempotente (segunda barrera).
 * 4. Registra PROCESADO / CONFLICTO / DESCARTADO. Ante un error inesperado la fila queda
 *    PENDIENTE y el reintento del cliente la reprocesa sin duplicar (compensación).
 */
@Injectable()
export class OfflineSyncProcessor {
  private readonly logger = new Logger(OfflineSyncProcessor.name);
  private readonly handlers: Map<string, IOfflineOperationHandler>;
  private readonly deviceLocks = new Map<string, Promise<unknown>>();
  private readonly clock: OfflineSyncClock;

  constructor(
    @Inject(SYNC_OPERATION_REPOSITORY)
    private readonly repository: ISyncOperationRepository,
    @Inject(DEVICE_REGISTRY)
    private readonly devices: IDeviceRegistry,
    @Inject(OFFLINE_OPERATION_HANDLERS)
    handlers: readonly IOfflineOperationHandler[],
    @Optional() @Inject(OFFLINE_SYNC_CLOCK) clock?: OfflineSyncClock,
  ) {
    this.handlers = new Map(handlers.map((h) => [h.tipo, h]));
    this.clock = clock ?? (() => Date.now());
  }

  async processBatch(
    user: AuthenticatedUser,
    batch: OfflineSyncBatchInput,
  ): Promise<OfflineSyncBatchReport> {
    await this.assertDeviceOwnership(user, batch.id_dispositivo);

    // Las ráfagas de un mismo dispositivo se procesan en serie (retransmisiones simultáneas).
    const previous =
      this.deviceLocks.get(batch.id_dispositivo) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.processSerialized(user, batch));
    this.deviceLocks.set(batch.id_dispositivo, current);
    try {
      return await current;
    } finally {
      if (this.deviceLocks.get(batch.id_dispositivo) === current) {
        this.deviceLocks.delete(batch.id_dispositivo);
      }
    }
  }

  private async assertDeviceOwnership(
    user: AuthenticatedUser,
    idDispositivo: string,
  ): Promise<void> {
    const device = await this.devices.findDevice(idDispositivo);
    if (!device || !device.activo || device.id_usuario !== user.id_usuario) {
      throw new ForbiddenException({
        code: "DISPOSITIVO_NO_AUTORIZADO",
        message:
          "El dispositivo no está registrado, está inactivo o no pertenece al usuario autenticado.",
      });
    }
  }

  private async processSerialized(
    user: AuthenticatedUser,
    batch: OfflineSyncBatchInput,
  ): Promise<OfflineSyncBatchReport> {
    // [PROPUESTA SRS] re-ordenamiento por marca de tiempo local antes de aplicar.
    const ordered = batch.operaciones
      .map((op, index) => ({ op, index, t: Date.parse(op.fecha_cliente) }))
      .sort((a, b) => a.t - b.t || a.index - b.index);

    const seenInBatch = new Map<string, OfflineOperationReport>();
    const reports: OfflineOperationReport[] = [];
    for (const [i, { op }] of ordered.entries()) {
      const repeated = seenInBatch.get(op.idempotency_key);
      const report = repeated
        ? { ...repeated, duplicado: true, orden_aplicacion: i + 1 }
        : await this.processOperation(user, batch.id_dispositivo, op, i + 1);
      seenInBatch.set(op.idempotency_key, report);
      reports.push(report);
    }

    const count = (pred: (r: OfflineOperationReport) => boolean) =>
      reports.filter(pred).length;
    return {
      id_dispositivo: batch.id_dispositivo,
      total: reports.length,
      procesadas: count((r) => r.estado === "PROCESADO" && !r.duplicado),
      duplicadas: count((r) => r.duplicado),
      conflictos: count((r) => r.estado === "CONFLICTO" && !r.duplicado),
      descartadas: count((r) => r.estado === "DESCARTADO" && !r.duplicado),
      errores_transitorios: count((r) => r.estado === "ERROR_TRANSITORIO"),
      operaciones: reports,
      fecha_servidor: new Date(this.clock()).toISOString(),
    };
  }

  private async processOperation(
    user: AuthenticatedUser,
    idDispositivo: string,
    op: OfflineOperationInput,
    orden: number,
  ): Promise<OfflineOperationReport> {
    const handler = this.handlers.get(op.tipo)!;
    const capturedAt = new Date(op.fecha_cliente);

    let claimed: StoredSyncOperation;
    try {
      const claim = await this.repository.claim({
        id_dispositivo: idDispositivo,
        idempotency_key: op.idempotency_key,
        entidad_afectada: handler.entidad_afectada,
        payload_json: {
          tipo: op.tipo,
          fecha_cliente: op.fecha_cliente,
          datos: redact(op.datos, handler.camposSensibles),
        },
        capturada_en_offline: capturedAt,
      });
      if (
        claim.status === "EXISTING" &&
        claim.operation.estado_sync !== "PENDIENTE"
      ) {
        return this.report(op, orden, claim.operation, true);
      }
      claimed = claim.operation;
    } catch (err: unknown) {
      return this.transientError(op, orden, null, err);
    }

    const skew = Math.abs(capturedAt.getTime() - this.clock());
    if (skew > MAX_CLIENT_CLOCK_SKEW_MS) {
      return this.finish(op, orden, claimed, "DESCARTADO", {
        codigo: "DESFASE_TEMPORAL",
        mensaje: `fecha_cliente difiere ${Math.round(skew / 60000)} min del reloj del servidor (máximo 24 h).`,
      });
    }

    try {
      const result = await handler.execute(op.datos, {
        user,
        id_dispositivo: idDispositivo,
        idempotency_key: `offline:${idDispositivo}:${op.idempotency_key}`,
      });
      if (result.kind === "INVALID") {
        return this.finish(op, orden, claimed, "DESCARTADO", {
          codigo: "PAYLOAD_INVALIDO",
          errores: result.errores,
        });
      }
      return this.finish(
        op,
        orden,
        claimed,
        result.conflicto ? "CONFLICTO" : "PROCESADO",
        { codigo: result.codigo, ...result.resultado },
      );
    } catch (err: unknown) {
      if (err instanceof HttpException && err.getStatus() < 500) {
        const body = err.getResponse();
        const payload =
          typeof body === "object" && body !== null
            ? (body as Record<string, unknown>)
            : { message: String(body) };
        return this.finish(op, orden, claimed, "CONFLICTO", {
          codigo: String(payload.code ?? payload.error ?? err.name),
          http_status: err.getStatus(),
          mensaje: payload.message ?? err.message,
        });
      }
      // Compensación: la fila queda PENDIENTE; el reintento la reprocesa y el caso de
      // uso, con la misma clave idempotente, no duplica lo que ya hubiera aplicado.
      return this.transientError(op, orden, claimed.id_sync, err);
    }
  }

  private async finish(
    op: OfflineOperationInput,
    orden: number,
    claimed: StoredSyncOperation,
    estado: Exclude<SyncOperationState, "PENDIENTE">,
    resultado: Record<string, unknown>,
  ): Promise<OfflineOperationReport> {
    try {
      const stored = await this.repository.complete(
        claimed.id_sync,
        estado,
        resultado,
      );
      return this.report(op, orden, stored, false);
    } catch (err: unknown) {
      return this.transientError(op, orden, claimed.id_sync, err);
    }
  }

  private report(
    op: OfflineOperationInput,
    orden: number,
    stored: StoredSyncOperation,
    duplicado: boolean,
  ): OfflineOperationReport {
    const resultado = stored.resultado_json ?? null;
    return {
      idempotency_key: op.idempotency_key,
      tipo: op.tipo,
      estado:
        stored.estado_sync === "PENDIENTE"
          ? "ERROR_TRANSITORIO"
          : stored.estado_sync,
      duplicado,
      codigo: String(resultado?.codigo ?? stored.estado_sync),
      orden_aplicacion: orden,
      fecha_cliente: op.fecha_cliente,
      fecha_servidor: stored.procesada_en_servidor.toISOString(),
      id_sync: stored.id_sync,
      resultado,
    };
  }

  private transientError(
    op: OfflineOperationInput,
    orden: number,
    idSync: string | null,
    err: unknown,
  ): OfflineOperationReport {
    this.logger.error(
      `Error transitorio sincronizando ${op.idempotency_key}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      idempotency_key: op.idempotency_key,
      tipo: op.tipo,
      estado: "ERROR_TRANSITORIO",
      duplicado: false,
      codigo: "REINTENTAR",
      orden_aplicacion: orden,
      fecha_cliente: op.fecha_cliente,
      fecha_servidor: new Date(this.clock()).toISOString(),
      id_sync: idSync,
      resultado: null,
    };
  }
}

/** Ley 1581: el QR y el documento del receptor no se guardan en claro en `sync_operation`. */
function redact(
  datos: Record<string, unknown>,
  sensitive: readonly string[],
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...datos };
  for (const field of sensitive) {
    if (copy[field] !== undefined && copy[field] !== null) {
      copy[field] = REDACTED;
    }
  }
  return copy;
}
