import { Injectable } from "@nestjs/common";
import { uuidv7 } from "@common/utils/uuidv7";
import { IJudicialAlertRepository } from "../domain/judicial-alert-repository.port";
import {
  ActiveJudicialAlertMatch,
  CreateJudicialAlertRecordInput,
  DeactivateJudicialAlertRecordInput,
  DuplicateJudicialAlertRadicadoError,
  JudicialAlertAlreadyDeactivatedError,
  JudicialAlertNotFoundError,
  StoredJudicialAlert,
} from "../domain/judicial-alert.types";

/**
 * Adaptador en memoria para la gestión segura de `alerta_judicial` (Issue #10).
 * Replica las restricciones de unicidad (`radicado_medida`), soft-delete y búsqueda
 * determinista por `documento_restringido_hash` de PostgreSQL 16 (V003 + V017).
 */
@Injectable()
export class InMemoryJudicialAlertRepository
  implements IJudicialAlertRepository
{
  private readonly alertsById = new Map<string, StoredJudicialAlert>();
  private readonly radicadoIndex = new Set<string>();

  async create(
    input: CreateJudicialAlertRecordInput,
  ): Promise<StoredJudicialAlert> {
    const normalizedRadicado = input.radicado_medida.trim();
    if (this.radicadoIndex.has(normalizedRadicado.toUpperCase())) {
      throw new DuplicateJudicialAlertRadicadoError(normalizedRadicado);
    }

    const now = new Date();
    const normalizedHash = input.individuo_blind_index.trim().toLowerCase();

    const record: StoredJudicialAlert = {
      id_alerta: uuidv7(now.getTime()),
      id_estudiante: input.id_estudiante,
      juzgado_emisor: input.juzgado_emisor.trim(),
      radicado_medida: normalizedRadicado,
      foto_individuo_cifrada: input.foto_individuo_cifrada,
      individuo_restringido_nombre_cifrado:
        input.individuo_restringido_nombre_cifrado,
      individuo_restringido_documento_cifrado:
        input.individuo_restringido_documento_cifrado,
      individuo_blind_index: normalizedHash,
      documento_restringido_hash: normalizedHash,
      orden_judicial_resumen_cifrado: input.orden_judicial_resumen_cifrado,
      activa: true,
      fecha_registro: now,
      registrado_por_rectoria: input.registrado_por_rectoria,
      eliminado_soft: false,
      eliminado_en: null,
      eliminado_por_coordinacion: null,
      autorizado_excepcion_por: null,
      hash_integridad_sha256: input.hash_integridad_sha256,
    };

    this.alertsById.set(record.id_alerta, record);
    this.radicadoIndex.add(normalizedRadicado.toUpperCase());

    return { ...record };
  }

  async findById(idAlerta: string): Promise<StoredJudicialAlert | null> {
    const found = this.alertsById.get(idAlerta);
    return found ? { ...found } : null;
  }

  async listByStudent(
    idEstudiante: string,
    includeInactive = false,
  ): Promise<StoredJudicialAlert[]> {
    return Array.from(this.alertsById.values())
      .filter(
        (alert) =>
          alert.id_estudiante === idEstudiante &&
          (includeInactive || (alert.activa && !alert.eliminado_soft)),
      )
      .sort((a, b) => b.fecha_registro.getTime() - a.fecha_registro.getTime())
      .map((alert) => ({ ...alert }));
  }

  async findActiveMatchByBlindIndex(
    idEstudiante: string,
    documentoRestringidoHash: string,
  ): Promise<ActiveJudicialAlertMatch | null> {
    const normalizedHash = documentoRestringidoHash.trim().toLowerCase();
    const match = Array.from(this.alertsById.values())
      .filter(
        (alert) =>
          alert.id_estudiante === idEstudiante &&
          alert.activa &&
          !alert.eliminado_soft &&
          alert.documento_restringido_hash === normalizedHash,
      )
      .sort((a, b) => b.fecha_registro.getTime() - a.fecha_registro.getTime())[0];

    if (!match) {
      return null;
    }

    return {
      bloqueada: true,
      id_alerta: match.id_alerta,
      id_estudiante: match.id_estudiante,
      radicado_medida: match.radicado_medida,
      juzgado_emisor: match.juzgado_emisor,
      documento_restringido_hash: match.documento_restringido_hash,
      fecha_registro: match.fecha_registro,
    };
  }

  async deactivateSoft(
    input: DeactivateJudicialAlertRecordInput,
  ): Promise<StoredJudicialAlert> {
    const existing = this.alertsById.get(input.id_alerta);
    if (!existing) {
      throw new JudicialAlertNotFoundError(input.id_alerta);
    }

    if (!existing.activa || existing.eliminado_soft) {
      throw new JudicialAlertAlreadyDeactivatedError(input.id_alerta);
    }

    existing.activa = false;
    existing.eliminado_soft = true;
    existing.eliminado_en = new Date();
    existing.eliminado_por_coordinacion = input.eliminado_por_coordinacion;
    existing.autorizado_excepcion_por = input.autorizado_excepcion_por;

    return { ...existing };
  }
}
