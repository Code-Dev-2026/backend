import { Injectable, OnModuleDestroy } from "@nestjs/common";
import type { Pool, PoolConfig } from "pg";
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SyncRow {
  id_sync: string;
  id_dispositivo: string;
  idempotency_key: string;
  entidad_afectada: string;
  estado_sync: SyncOperationState;
  capturada_en_offline: Date;
  procesada_en_servidor: Date;
  resultado_json: Record<string, unknown> | null;
}

const COLUMNS = `id_sync, id_dispositivo, idempotency_key, entidad_afectada, estado_sync,
  capturada_en_offline, procesada_en_servidor, resultado_json`;

/**
 * `sync_operation` en PostgreSQL 16 (Issue #16).
 * La deduplicación la garantiza `unq_sync_dispositivo_idempotency` (V007) con
 * `INSERT … ON CONFLICT (id_dispositivo, idempotency_key) DO NOTHING`.
 */
@Injectable()
export class PostgresSyncOperationRepository
  implements ISyncOperationRepository, OnModuleDestroy
{
  constructor(
    private readonly pool: Pool,
    private readonly ownsPool = false,
  ) {}

  static fromConfig(config: PoolConfig): PostgresSyncOperationRepository {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Pool: PgPool } = require("pg") as typeof import("pg");
    return new PostgresSyncOperationRepository(new PgPool(config), true);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  async claim(
    input: ClaimSyncOperationInput,
  ): Promise<ClaimSyncOperationResult> {
    const inserted = await this.pool.query<SyncRow>(
      `INSERT INTO public.sync_operation (
         id_dispositivo, idempotency_key, entidad_afectada, operacion_tipo,
         payload_json, estado_sync, capturada_en_offline
       )
       VALUES ($1::uuid, $2, $3, 'INSERT', $4::jsonb, 'PENDIENTE', $5::timestamptz)
       ON CONFLICT (id_dispositivo, idempotency_key) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        input.id_dispositivo,
        input.idempotency_key,
        input.entidad_afectada,
        JSON.stringify(input.payload_json),
        input.capturada_en_offline.toISOString(),
      ],
    );
    if (inserted.rows[0]) {
      return { status: "CLAIMED", operation: inserted.rows[0] };
    }

    const existing = await this.pool.query<SyncRow>(
      `SELECT ${COLUMNS}
         FROM public.sync_operation
        WHERE id_dispositivo = $1::uuid AND idempotency_key = $2`,
      [input.id_dispositivo, input.idempotency_key],
    );
    if (!existing.rows[0]) {
      throw new Error("Conflicto de idempotencia sin fila recuperable.");
    }
    return { status: "EXISTING", operation: existing.rows[0] };
  }

  async complete(
    idSync: string,
    estado: Exclude<SyncOperationState, "PENDIENTE">,
    resultado: Record<string, unknown>,
  ): Promise<StoredSyncOperation> {
    const res = await this.pool.query<SyncRow>(
      `UPDATE public.sync_operation
          SET estado_sync = $2::varchar,
              resultado_json = $3::jsonb,
              procesada_en_servidor = clock_timestamp()
        WHERE id_sync = $1::uuid
        RETURNING ${COLUMNS}`,
      [idSync, estado, JSON.stringify(resultado)],
    );
    if (!res.rows[0]) {
      throw new Error(`sync_operation ${idSync} inexistente.`);
    }
    return res.rows[0];
  }
}

/** `dispositivo` en PostgreSQL (V002). */
@Injectable()
export class PostgresDeviceRegistry
  implements IDeviceRegistry, OnModuleDestroy
{
  constructor(
    private readonly pool: Pool,
    private readonly ownsPool = false,
  ) {}

  static fromConfig(config: PoolConfig): PostgresDeviceRegistry {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Pool: PgPool } = require("pg") as typeof import("pg");
    return new PostgresDeviceRegistry(new PgPool(config), true);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  async findDevice(idDispositivo: string): Promise<RegisteredDevice | null> {
    if (!UUID_PATTERN.test(idDispositivo)) {
      return null;
    }
    const res = await this.pool.query<RegisteredDevice>(
      `SELECT id_dispositivo, id_usuario, activo
         FROM public.dispositivo
        WHERE id_dispositivo = $1::uuid`,
      [idDispositivo],
    );
    return res.rows[0] ?? null;
  }
}
