import { Injectable, OnModuleDestroy } from "@nestjs/common";
import type { Pool, PoolConfig } from "pg";
import { IJudicialAlertRepository } from "../domain/judicial-alert-repository.port";
import {
  ActiveJudicialAlertMatch,
  CreateJudicialAlertRecordInput,
  DeactivateJudicialAlertRecordInput,
  DuplicateJudicialAlertRadicadoError,
  InvalidJudicialAlertDocumentError,
  JudicialAlertAlreadyDeactivatedError,
  JudicialAlertNotFoundError,
  RecordJudicialEmergencyIncidentInput,
  RecordJudicialEmergencyIncidentResult,
  StoredJudicialAlert,
} from "../domain/judicial-alert.types";

interface PgErrorLike {
  code?: string;
  message?: string;
  constraint?: string;
}

interface JudicialAlertRow {
  id_alerta: string;
  id_estudiante: string;
  juzgado_emisor: string;
  radicado_medida: string;
  foto_individuo_cifrada: string;
  individuo_restringido_nombre_cifrado: string;
  individuo_restringido_documento_cifrado: string;
  individuo_blind_index: string;
  documento_restringido_hash: string;
  orden_judicial_resumen_cifrado: string;
  activa: boolean;
  fecha_registro: Date;
  registrado_por_rectoria: string;
  eliminado_soft: boolean;
  eliminado_en: Date | null;
  eliminado_por_coordinacion: string | null;
  autorizado_excepcion_por: string | null;
  hash_integridad_sha256: string;
}

interface VerifyAlertRow {
  bloqueada: boolean;
  id_alerta: string | null;
  radicado_medida: string | null;
  juzgado_emisor: string | null;
  documento_restringido_hash: string;
  fecha_registro: Date | null;
}

interface JudicialEmergencyIncidentRow {
  id_incidente: string;
  id_notificacion_principal: string | null;
  id_acudientes_notificados: string[] | null;
  notificaciones_creadas: number;
  alerta_policia_infancia_registrada: boolean;
  fecha_hora: Date;
}

/**
 * Adaptador PostgreSQL 16 para la tabla `public.alerta_judicial` y las funciones
 * `fn_verificar_alerta_judicial_activa` / `fn_registrar_incidente_alerta_judicial` (V003 + V017).
 */
@Injectable()
export class PostgresJudicialAlertRepository
  implements IJudicialAlertRepository, OnModuleDestroy
{
  private readonly ownsPool: boolean;

  constructor(
    private readonly pool: Pool,
    ownsPool = false,
  ) {
    this.ownsPool = ownsPool;
  }

  static fromConfig(config: PoolConfig): PostgresJudicialAlertRepository {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Pool: PgPool } = require("pg") as typeof import("pg");
    return new PostgresJudicialAlertRepository(new PgPool(config), true);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  async create(
    input: CreateJudicialAlertRecordInput,
  ): Promise<StoredJudicialAlert> {
    try {
      const { rows } = await this.pool.query<JudicialAlertRow>(
        `INSERT INTO public.alerta_judicial (
           id_estudiante,
           juzgado_emisor,
           radicado_medida,
           foto_individuo_cifrada,
           individuo_restringido_nombre_cifrado,
           individuo_restringido_documento_cifrado,
           individuo_blind_index,
           orden_judicial_resumen_cifrado,
           activa,
           registrado_por_rectoria,
           hash_integridad_sha256
         )
         VALUES (
           $1::uuid,
           $2::varchar,
           $3::varchar,
           $4::formato_cifrado_aes,
           $5::formato_cifrado_aes,
           $6::formato_cifrado_aes,
           $7::varchar,
           $8::formato_cifrado_aes,
           TRUE,
           $9::uuid,
           $10::varchar
         )
         RETURNING
           id_alerta,
           id_estudiante,
           juzgado_emisor,
           radicado_medida,
           foto_individuo_cifrada::text AS foto_individuo_cifrada,
           individuo_restringido_nombre_cifrado::text AS individuo_restringido_nombre_cifrado,
           individuo_restringido_documento_cifrado::text AS individuo_restringido_documento_cifrado,
           individuo_blind_index,
           documento_restringido_hash,
           orden_judicial_resumen_cifrado::text AS orden_judicial_resumen_cifrado,
           activa,
           fecha_registro,
           registrado_por_rectoria,
           eliminado_soft,
           eliminado_en,
           eliminado_por_coordinacion,
           autorizado_excepcion_por,
           hash_integridad_sha256`,
        [
          input.id_estudiante,
          input.juzgado_emisor.trim(),
          input.radicado_medida.trim(),
          input.foto_individuo_cifrada,
          input.individuo_restringido_nombre_cifrado,
          input.individuo_restringido_documento_cifrado,
          input.individuo_blind_index.trim().toLowerCase(),
          input.orden_judicial_resumen_cifrado,
          input.registrado_por_rectoria,
          input.hash_integridad_sha256,
        ],
      );

      return this.mapRow(rows[0]);
    } catch (error) {
      const pgErr = error as PgErrorLike;
      if (pgErr?.code === "23505") {
        throw new DuplicateJudicialAlertRadicadoError(
          input.radicado_medida.trim(),
        );
      }
      throw error;
    }
  }

  async findById(idAlerta: string): Promise<StoredJudicialAlert | null> {
    const { rows } = await this.pool.query<JudicialAlertRow>(
      `SELECT
         id_alerta,
         id_estudiante,
         juzgado_emisor,
         radicado_medida,
         foto_individuo_cifrada::text AS foto_individuo_cifrada,
         individuo_restringido_nombre_cifrado::text AS individuo_restringido_nombre_cifrado,
         individuo_restringido_documento_cifrado::text AS individuo_restringido_documento_cifrado,
         individuo_blind_index,
         documento_restringido_hash,
         orden_judicial_resumen_cifrado::text AS orden_judicial_resumen_cifrado,
         activa,
         fecha_registro,
         registrado_por_rectoria,
         eliminado_soft,
         eliminado_en,
         eliminado_por_coordinacion,
         autorizado_excepcion_por,
         hash_integridad_sha256
       FROM public.alerta_judicial
       WHERE id_alerta = $1::uuid`,
      [idAlerta],
    );

    return rows[0] ? this.mapRow(rows[0]) : null;
  }

  async listByStudent(
    idEstudiante: string,
    includeInactive = false,
  ): Promise<StoredJudicialAlert[]> {
    const activeClause = includeInactive
      ? ""
      : "AND activa = TRUE AND eliminado_soft = FALSE";

    const { rows } = await this.pool.query<JudicialAlertRow>(
      `SELECT
         id_alerta,
         id_estudiante,
         juzgado_emisor,
         radicado_medida,
         foto_individuo_cifrada::text AS foto_individuo_cifrada,
         individuo_restringido_nombre_cifrado::text AS individuo_restringido_nombre_cifrado,
         individuo_restringido_documento_cifrado::text AS individuo_restringido_documento_cifrado,
         individuo_blind_index,
         documento_restringido_hash,
         orden_judicial_resumen_cifrado::text AS orden_judicial_resumen_cifrado,
         activa,
         fecha_registro,
         registrado_por_rectoria,
         eliminado_soft,
         eliminado_en,
         eliminado_por_coordinacion,
         autorizado_excepcion_por,
         hash_integridad_sha256
       FROM public.alerta_judicial
       WHERE id_estudiante = $1::uuid ${activeClause}
       ORDER BY fecha_registro DESC`,
      [idEstudiante],
    );

    return rows.map((row) => this.mapRow(row));
  }

  async findActiveMatchByBlindIndex(
    idEstudiante: string,
    documentoRestringidoHash: string,
  ): Promise<ActiveJudicialAlertMatch | null> {
    try {
      const { rows } = await this.pool.query<VerifyAlertRow>(
        `SELECT
           bloqueada,
           id_alerta,
           radicado_medida,
           juzgado_emisor,
           documento_restringido_hash,
           fecha_registro
         FROM public.fn_verificar_alerta_judicial_activa($1::uuid, $2::varchar)`,
        [idEstudiante, documentoRestringidoHash.trim().toLowerCase()],
      );

      const row = rows[0];
      if (!row || !row.bloqueada || !row.id_alerta) {
        return null;
      }

      return {
        bloqueada: true,
        id_alerta: row.id_alerta,
        id_estudiante: idEstudiante,
        radicado_medida: row.radicado_medida ?? "",
        juzgado_emisor: row.juzgado_emisor ?? "",
        documento_restringido_hash: row.documento_restringido_hash,
        fecha_registro: row.fecha_registro
          ? new Date(row.fecha_registro)
          : new Date(),
      };
    } catch (error) {
      const pgErr = error as PgErrorLike;
      if (pgErr?.code === "22023") {
        throw new InvalidJudicialAlertDocumentError(
          pgErr.message ?? "Blind index judicial inválido.",
        );
      }
      throw error;
    }
  }

  async deactivateSoft(
    input: DeactivateJudicialAlertRecordInput,
  ): Promise<StoredJudicialAlert> {
    const existing = await this.findById(input.id_alerta);
    if (!existing) {
      throw new JudicialAlertNotFoundError(input.id_alerta);
    }
    if (!existing.activa || existing.eliminado_soft) {
      throw new JudicialAlertAlreadyDeactivatedError(input.id_alerta);
    }

    const { rows } = await this.pool.query<JudicialAlertRow>(
      `UPDATE public.alerta_judicial
       SET
         activa = FALSE,
         eliminado_soft = TRUE,
         eliminado_en = clock_timestamp(),
         eliminado_por_coordinacion = $2::uuid,
         autorizado_excepcion_por = $3::varchar
       WHERE id_alerta = $1::uuid
       RETURNING
         id_alerta,
         id_estudiante,
         juzgado_emisor,
         radicado_medida,
         foto_individuo_cifrada::text AS foto_individuo_cifrada,
         individuo_restringido_nombre_cifrado::text AS individuo_restringido_nombre_cifrado,
         individuo_restringido_documento_cifrado::text AS individuo_restringido_documento_cifrado,
         individuo_blind_index,
         documento_restringido_hash,
         orden_judicial_resumen_cifrado::text AS orden_judicial_resumen_cifrado,
         activa,
         fecha_registro,
         registrado_por_rectoria,
         eliminado_soft,
         eliminado_en,
         eliminado_por_coordinacion,
         autorizado_excepcion_por,
         hash_integridad_sha256`,
      [
        input.id_alerta,
        input.eliminado_por_coordinacion,
        input.autorizado_excepcion_por,
      ],
    );

    return this.mapRow(rows[0]);
  }

  async recordJudicialBlockIncidentAndNotifications(
    input: RecordJudicialEmergencyIncidentInput,
  ): Promise<RecordJudicialEmergencyIncidentResult> {
    const { rows } = await this.pool.query<JudicialEmergencyIncidentRow>(
      `SELECT
         id_incidente,
         id_notificacion_principal,
         id_acudientes_notificados,
         notificaciones_creadas,
         alerta_policia_infancia_registrada,
         fecha_hora
       FROM public.fn_registrar_incidente_alerta_judicial(
         $1::uuid,
         $2::uuid,
         $3::uuid,
         $4::varchar,
         $5::varchar,
         $6::varchar,
         $7::double precision,
         $8::double precision,
         $9::uuid,
         $10::text
       )`,
      [
        input.id_viaje,
        input.id_estudiante,
        input.id_alerta,
        input.documento_restringido_hash.trim().toLowerCase(),
        input.radicado_medida,
        input.juzgado_emisor,
        input.latitud,
        input.longitud,
        input.registrado_por_usuario,
        input.descripcion ?? null,
      ],
    );

    const row = rows[0];
    return {
      id_incidente: row.id_incidente,
      id_notificacion_principal: row.id_notificacion_principal,
      id_acudientes_notificados: row.id_acudientes_notificados ?? [],
      notificaciones_creadas: Number(row.notificaciones_creadas),
      alerta_policia_infancia_registrada: Boolean(
        row.alerta_policia_infancia_registrada,
      ),
      fecha_hora: new Date(row.fecha_hora),
    };
  }

  private mapRow(row: JudicialAlertRow): StoredJudicialAlert {
    return {
      ...row,
      fecha_registro: new Date(row.fecha_registro),
      eliminado_en: row.eliminado_en ? new Date(row.eliminado_en) : null,
    };
  }
}
