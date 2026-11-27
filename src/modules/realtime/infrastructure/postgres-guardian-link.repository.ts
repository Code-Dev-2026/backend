import { Injectable, OnModuleDestroy } from "@nestjs/common";
import type { Pool, PoolConfig } from "pg";
import { IGuardianLinkRepository } from "../domain/realtime-ports";
import { GuardianStudentLink } from "../domain/realtime.types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface GuardianLinkRow {
  id_usuario: string;
  id_acudiente: string;
  id_estudiante: string;
}

/**
 * Adaptador PostgreSQL 16 del parentesco familiar (Issue #14 — RNF-02).
 *
 * Resuelve los acudientes con cuenta `ACTIVO` vinculados a los estudiantes del viaje
 * mediante `estudiante_acudiente` (índice `idx_estudiante_acudiente_acudiente`, V003).
 */
@Injectable()
export class PostgresGuardianLinkRepository
  implements IGuardianLinkRepository, OnModuleDestroy
{
  constructor(
    private readonly pool: Pool,
    private readonly ownsPool = false,
  ) {}

  static fromConfig(config: PoolConfig): PostgresGuardianLinkRepository {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Pool: PgPool } = require("pg") as typeof import("pg");
    return new PostgresGuardianLinkRepository(new PgPool(config), true);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  async listGuardianLinksForStudents(
    idEstudiantes: readonly string[],
  ): Promise<GuardianStudentLink[]> {
    const ids = idEstudiantes.filter((id) => UUID_PATTERN.test(id));
    if (ids.length === 0) {
      return [];
    }

    const res = await this.pool.query<GuardianLinkRow>(
      `SELECT a.id_usuario, a.id_acudiente, ea.id_estudiante
         FROM public.estudiante_acudiente ea
         JOIN public.acudiente a ON a.id_acudiente = ea.id_acudiente
         JOIN public.usuario u ON u.id_usuario = a.id_usuario
        WHERE ea.id_estudiante = ANY($1::uuid[])
          AND u.estado = 'ACTIVO'`,
      [ids],
    );
    return res.rows.map((r) => ({
      id_usuario: r.id_usuario,
      id_acudiente: r.id_acudiente,
      id_estudiante: r.id_estudiante,
    }));
  }
}
