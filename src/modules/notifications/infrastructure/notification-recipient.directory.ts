import { Injectable, OnModuleDestroy } from "@nestjs/common";
import type { Pool, PoolConfig } from "pg";
import { INotificationRecipientDirectory } from "../domain/notification-dispatch.ports";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Directorio en memoria de acudientes legitimados por estudiante (pruebas y desarrollo). */
@Injectable()
export class InMemoryNotificationRecipientDirectory implements INotificationRecipientDirectory {
  private readonly guardiansByStudent = new Map<string, Set<string>>();

  registerGuardian(idEstudiante: string, idAcudiente: string): void {
    const set = this.guardiansByStudent.get(idEstudiante) ?? new Set<string>();
    set.add(idAcudiente);
    this.guardiansByStudent.set(idEstudiante, set);
  }

  async listGuardianIdsOfStudent(idEstudiante: string): Promise<string[]> {
    return Array.from(this.guardiansByStudent.get(idEstudiante) ?? []);
  }
}

/**
 * Directorio PostgreSQL: acudientes con cuenta `ACTIVO` vinculados en `estudiante_acudiente`,
 * en el orden de notificación del tutor (`es_tutor_principal`, `orden_notificacion`).
 */
@Injectable()
export class PostgresNotificationRecipientDirectory
  implements INotificationRecipientDirectory, OnModuleDestroy
{
  constructor(
    private readonly pool: Pool,
    private readonly ownsPool = false,
  ) {}

  static fromConfig(
    config: PoolConfig,
  ): PostgresNotificationRecipientDirectory {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Pool: PgPool } = require("pg") as typeof import("pg");
    return new PostgresNotificationRecipientDirectory(new PgPool(config), true);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  async listGuardianIdsOfStudent(idEstudiante: string): Promise<string[]> {
    if (!UUID_PATTERN.test(idEstudiante)) {
      return [];
    }
    const res = await this.pool.query<{ id_acudiente: string }>(
      `SELECT ea.id_acudiente
         FROM public.estudiante_acudiente ea
         JOIN public.acudiente a ON a.id_acudiente = ea.id_acudiente
         JOIN public.usuario u ON u.id_usuario = a.id_usuario
        WHERE ea.id_estudiante = $1::uuid
          AND u.estado = 'ACTIVO'
        ORDER BY ea.es_tutor_principal DESC, ea.orden_notificacion ASC`,
      [idEstudiante],
    );
    return res.rows.map((r) => r.id_acudiente);
  }
}
