import { Injectable } from "@nestjs/common";

export type ImportLedgerState = "EN_PROCESO" | "COMPLETADA";

/** Tabla `importacion_matricula` (V012): un registro por hash de archivo. */
export interface ImportLedgerRecord {
  hash_sha256: string;
  estado: ImportLedgerState;
  id_usuario: string;
  id_colegio: string;
  tipo_archivo: string;
  tamano_bytes: number;
  filas_creadas: number;
  creado_en: Date;
  completado_en: Date | null;
}

export type ReserveResult =
  { reserved: true } | { reserved: false; existing: ImportLedgerRecord };

/**
 * Puerto del registro de importaciones (idempotencia por SHA-256).
 * - reserve(): INSERT ... ON CONFLICT (hash_sha256) DO NOTHING, atómico,
 *   para que dos cargas simultáneas del mismo archivo no se procesen dos veces.
 * - complete(): marca la carga como confirmada (tras el COMMIT).
 * - release(): borra la reserva si la importación se revirtió, para poder
 *   reintentar el mismo archivo tras corregir el problema externo (p. ej. FK).
 */
export interface IImportLedger {
  reserve(record: ImportLedgerRecord): Promise<ReserveResult>;
  complete(hash: string, filasCreadas: number): Promise<void>;
  release(hash: string): Promise<void>;
  findByHash(hash: string): Promise<ImportLedgerRecord | null>;
}

export const IMPORT_LEDGER = Symbol("IImportLedger");

/** Adaptador TEMPORAL en memoria (reemplazar por PostgreSQL). */
@Injectable()
export class InMemoryImportLedger implements IImportLedger {
  private readonly records = new Map<string, ImportLedgerRecord>();

  async reserve(record: ImportLedgerRecord): Promise<ReserveResult> {
    const existing = this.records.get(record.hash_sha256);
    if (existing) {
      return { reserved: false, existing: { ...existing } };
    }
    // Sin await entre la lectura y la escritura: atómico en el event loop.
    this.records.set(record.hash_sha256, { ...record });
    return { reserved: true };
  }

  async complete(hash: string, filasCreadas: number): Promise<void> {
    const record = this.records.get(hash);
    if (record) {
      record.estado = "COMPLETADA";
      record.filas_creadas = filasCreadas;
      record.completado_en = new Date();
    }
  }

  async release(hash: string): Promise<void> {
    const record = this.records.get(hash);
    if (record?.estado === "EN_PROCESO") {
      this.records.delete(hash);
    }
  }

  async findByHash(hash: string): Promise<ImportLedgerRecord | null> {
    const record = this.records.get(hash);
    return record ? { ...record } : null;
  }
}
