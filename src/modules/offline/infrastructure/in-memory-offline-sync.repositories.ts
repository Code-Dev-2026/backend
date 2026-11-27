import { Injectable } from "@nestjs/common";
import { uuidv7 } from "@common/utils/uuidv7";
import {
  IDeviceRegistry,
  ISyncOperationRepository,
} from "../domain/offline-sync.ports";
import {
  ClaimSyncOperationInput,
  ClaimSyncOperationResult,
  RegisteredDevice,
  StoredSyncOperation,
  SyncOperationState,
} from "../domain/offline-sync.types";

interface StoredRow extends StoredSyncOperation {
  readonly payload_json: Record<string, unknown>;
}

/**
 * `sync_operation` en memoria (modo por defecto, `OFFLINE_USE_POSTGRES != true`).
 * Replica `UNIQUE (id_dispositivo, idempotency_key)`.
 */
@Injectable()
export class InMemorySyncOperationRepository implements ISyncOperationRepository {
  private readonly byId = new Map<string, StoredRow>();
  private readonly idByKey = new Map<string, string>();

  async claim(
    input: ClaimSyncOperationInput,
  ): Promise<ClaimSyncOperationResult> {
    const key = `${input.id_dispositivo}|${input.idempotency_key}`;
    const existingId = this.idByKey.get(key);
    if (existingId) {
      return {
        status: "EXISTING",
        operation: copy(this.byId.get(existingId)!),
      };
    }
    const row: StoredRow = {
      id_sync: uuidv7(),
      id_dispositivo: input.id_dispositivo,
      idempotency_key: input.idempotency_key,
      entidad_afectada: input.entidad_afectada,
      estado_sync: "PENDIENTE",
      capturada_en_offline: input.capturada_en_offline,
      procesada_en_servidor: new Date(),
      resultado_json: null,
      payload_json: { ...input.payload_json },
    };
    this.byId.set(row.id_sync, row);
    this.idByKey.set(key, row.id_sync);
    return { status: "CLAIMED", operation: copy(row) };
  }

  async complete(
    idSync: string,
    estado: Exclude<SyncOperationState, "PENDIENTE">,
    resultado: Record<string, unknown>,
  ): Promise<StoredSyncOperation> {
    const current = this.byId.get(idSync);
    if (!current) {
      throw new Error(`sync_operation ${idSync} inexistente.`);
    }
    const updated: StoredRow = {
      ...current,
      estado_sync: estado,
      resultado_json: { ...resultado },
      procesada_en_servidor: new Date(),
    };
    this.byId.set(idSync, updated);
    return copy(updated);
  }

  listAll(): Array<
    StoredSyncOperation & { payload_json: Record<string, unknown> }
  > {
    return Array.from(this.byId.values()).map((r) => ({
      ...copy(r),
      payload_json: { ...r.payload_json },
    }));
  }
}

function copy(row: StoredRow): StoredSyncOperation {
  return {
    id_sync: row.id_sync,
    id_dispositivo: row.id_dispositivo,
    idempotency_key: row.idempotency_key,
    entidad_afectada: row.entidad_afectada,
    estado_sync: row.estado_sync,
    capturada_en_offline: row.capturada_en_offline,
    procesada_en_servidor: row.procesada_en_servidor,
    resultado_json: row.resultado_json ? { ...row.resultado_json } : null,
  };
}

/** Registro de dispositivos en memoria (pruebas y desarrollo). */
@Injectable()
export class InMemoryDeviceRegistry implements IDeviceRegistry {
  private readonly devices = new Map<string, RegisteredDevice>();

  registerDevice(device: RegisteredDevice): void {
    this.devices.set(device.id_dispositivo, { ...device });
  }

  async findDevice(idDispositivo: string): Promise<RegisteredDevice | null> {
    const found = this.devices.get(idDispositivo);
    return found ? { ...found } : null;
  }
}
