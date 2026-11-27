import { Injectable, OnModuleDestroy } from "@nestjs/common";
import type { Pool, PoolConfig } from "pg";
import { uuidv7 } from "@common/utils/uuidv7";
import { INotificationRepository } from "../domain/notification-dispatch.ports";
import {
  DispatchNotificationCommand,
  NotificationDeliveryState,
  NotificationTypeCode,
  RecordDeliveryAttemptInput,
  StoredNotification,
  UpsertNotificationResult,
} from "../domain/notification-dispatch.types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface NotificationRow {
  id_notificacion: string;
  idempotency_key: string;
  codigo_tipo: NotificationTypeCode;
  id_acudiente: string;
  id_estudiante: string | null;
  id_viaje: string | null;
  canal: string;
  titulo: string;
  contenido_mensaje: string;
  payload_adicional: Record<string, unknown> | null;
  silenciable: boolean;
  estado_envio: NotificationDeliveryState;
  intentos_realizados: number;
  max_intentos: number;
  ultimo_error: string | null;
  despachada_en: Date | null;
  entregada_en: Date | null;
  creado_en: Date;
}

const SELECT_COLUMNS = `
  n.id_notificacion, n.idempotency_key, tn.codigo AS codigo_tipo, n.id_acudiente,
  n.id_estudiante, n.id_viaje, n.canal, n.titulo, n.contenido_mensaje,
  n.payload_adicional, n.silenciable, n.estado_envio, n.intentos_realizados,
  n.max_intentos, n.ultimo_error, n.despachada_en, n.entregada_en, n.creado_en`;

/**
 * Adaptador PostgreSQL 16 de `notificacion` (Issue #15).
 *
 * - `INSERT … SELECT FROM tipo_notificacion WHERE codigo = $` clasifica la fila y toma
 *   `canal_default` del catálogo (mismo criterio que V015/V016).
 * - `ON CONFLICT (idempotency_key) DO NOTHING` reutiliza la fila ya creada por las
 *   funciones atómicas de abordaje/desembarque, sin duplicar notificaciones.
 */
@Injectable()
export class PostgresNotificationRepository
  implements INotificationRepository, OnModuleDestroy
{
  constructor(
    private readonly pool: Pool,
    private readonly ownsPool = false,
  ) {}

  static fromConfig(config: PoolConfig): PostgresNotificationRepository {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Pool: PgPool } = require("pg") as typeof import("pg");
    return new PostgresNotificationRepository(new PgPool(config), true);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  async upsertPending(
    command: DispatchNotificationCommand,
  ): Promise<UpsertNotificationResult> {
    const requestedId = command.id_notificacion?.trim();
    const id =
      requestedId && UUID_PATTERN.test(requestedId) ? requestedId : uuidv7();

    const inserted = await this.pool.query<{ id_notificacion: string }>(
      `INSERT INTO public.notificacion (
         id_notificacion, id_tipo, id_estudiante, id_acudiente, id_viaje, canal,
         titulo, contenido_mensaje, payload_adicional, silenciable, estado_envio,
         idempotency_key
       )
       SELECT $1::uuid, tn.id_tipo, $3::uuid, $4::uuid, $5::uuid, tn.canal_default,
              $6, $7, $8::jsonb, $9, 'PENDIENTE', $10
         FROM public.tipo_notificacion tn
        WHERE tn.codigo = $2
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id_notificacion`,
      [
        id,
        command.codigo_tipo,
        command.id_estudiante,
        command.id_acudiente,
        command.id_viaje,
        command.titulo.slice(0, 150),
        command.mensaje,
        JSON.stringify(command.payload),
        command.silenciable ?? false,
        command.idempotency_key.slice(0, 120),
      ],
    );

    const row = await this.selectOne(
      `WHERE n.idempotency_key = $1`,
      command.idempotency_key.slice(0, 120),
    );
    if (!row) {
      throw new Error(
        `tipo_notificacion '${command.codigo_tipo}' no existe en el catálogo (V007).`,
      );
    }
    return { notification: row, created: inserted.rowCount === 1 };
  }

  async recordAttempt(
    idNotificacion: string,
    input: RecordDeliveryAttemptInput,
  ): Promise<StoredNotification> {
    await this.pool.query(
      `UPDATE public.notificacion
          SET intentos_realizados = intentos_realizados + 1,
              estado_envio = $2::varchar,
              ultimo_error = $3::text,
              despachada_en = CASE WHEN $2::varchar IN ('ENVIADA', 'ENTREGADA')
                                   THEN COALESCE(despachada_en, clock_timestamp())
                                   ELSE despachada_en END,
              entregada_en = CASE WHEN $2::varchar = 'ENTREGADA'
                                  THEN COALESCE(entregada_en, clock_timestamp())
                                  ELSE entregada_en END
        WHERE id_notificacion = $1::uuid`,
      [idNotificacion, input.estado_envio, input.ultimo_error],
    );
    const row = await this.selectOne(
      `WHERE n.id_notificacion = $1::uuid`,
      idNotificacion,
    );
    if (!row) {
      throw new Error(`Notificación ${idNotificacion} inexistente.`);
    }
    return row;
  }

  async findById(idNotificacion: string): Promise<StoredNotification | null> {
    if (!UUID_PATTERN.test(idNotificacion)) {
      return null;
    }
    return this.selectOne(`WHERE n.id_notificacion = $1::uuid`, idNotificacion);
  }

  private async selectOne(
    where: string,
    param: string,
  ): Promise<StoredNotification | null> {
    const res = await this.pool.query<NotificationRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM public.notificacion n
         JOIN public.tipo_notificacion tn ON tn.id_tipo = n.id_tipo
        ${where}`,
      [param],
    );
    const row = res.rows[0];
    return row ? toStored(row) : null;
  }
}

function toStored(row: NotificationRow): StoredNotification {
  const payload: Record<string, string> = {};
  for (const [k, v] of Object.entries(row.payload_adicional ?? {})) {
    payload[k] = v === null || v === undefined ? "" : String(v);
  }
  return {
    id_notificacion: row.id_notificacion,
    idempotency_key: row.idempotency_key,
    codigo_tipo: row.codigo_tipo,
    id_acudiente: row.id_acudiente,
    id_estudiante: row.id_estudiante,
    id_viaje: row.id_viaje,
    canal: row.canal,
    titulo: row.titulo,
    contenido_mensaje: row.contenido_mensaje,
    payload_adicional: payload,
    silenciable: row.silenciable,
    estado_envio: row.estado_envio,
    intentos_realizados: row.intentos_realizados,
    max_intentos: row.max_intentos,
    ultimo_error: row.ultimo_error,
    despachada_en: row.despachada_en,
    entregada_en: row.entregada_en,
    creado_en: row.creado_en,
  };
}
