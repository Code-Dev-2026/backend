import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { BlindIndexService } from "@common/crypto/blind-index.service";
import { CryptoVaultService } from "@common/crypto/crypto-vault.service";
import { HashService } from "@common/crypto/hash.service";
import { AuditService } from "../../audit/audit.service";
import { normalizeDocument } from "../../students/domain/student.entity";
import {
  IJudicialAlertRepository,
  JUDICIAL_ALERT_REPOSITORY,
} from "./domain/judicial-alert-repository.port";
import {
  ActiveJudicialAlertMatch,
  DuplicateJudicialAlertRadicadoError,
  InvalidJudicialAlertDocumentError,
  JUDICIAL_BLOCKING_CODE,
  JudicialAlertAlreadyDeactivatedError,
  JudicialAlertDecryptedView,
  JudicialAlertNotFoundError,
  JudicialAlertVerificationResponse,
  JudicialProtectionEngineError,
  RecordJudicialEmergencyIncidentInput,
  RecordJudicialEmergencyIncidentResult,
  StoredJudicialAlert,
} from "./domain/judicial-alert.types";
import {
  CreateJudicialAlertDto,
  DeactivateJudicialAlertDto,
  VerifyJudicialAlertDto,
} from "./dto/judicial-alert.dto";

const BLIND_INDEX_HEX_RE = /^[a-f0-9]{64}$/;
const DEFAULT_ENCRYPTED_PHOTO_PLACEHOLDER = "SIN_FOTOGRAFIA_ADJUNTA";

/**
 * Servicio SRP de gestión y consulta determinista segura de `alerta_judicial`
 * (Issue #10: RF-02, RF-09, RNF-01, OWASP ASVS V1.14).
 *
 * - Cifra en reposo los datos sensibles de la orden judicial con AES-256-GCM.
 * - Deriva `documento_restringido_hash` con HMAC-SHA256 sobre el documento único
 *   de identidad normalizado (mitigación de falsos positivos por homonimia).
 * - Falla de forma segura (fail-safe): ante error técnico del motor o entrada
 *   inconsistente, bloquea la entrega y deja evidencia auditable.
 */
@Injectable()
export class JudicialAlertsService {
  constructor(
    @Inject(JUDICIAL_ALERT_REPOSITORY)
    private readonly repository: IJudicialAlertRepository,
    private readonly cryptoVault: CryptoVaultService,
    private readonly hashService: HashService,
    @Optional() private readonly blindIndexService?: BlindIndexService,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  computeRestrictedDocumentHash(documento: string): string {
    const normalized = normalizeDocument(documento ?? "");
    if (!normalized || normalized.length < 4) {
      throw new InvalidJudicialAlertDocumentError(
        "El documento del individuo restringido es obligatorio y debe tener al menos 4 caracteres alfanuméricos.",
      );
    }

    if (this.cryptoVault) {
      return this.cryptoVault.generateBlindIndex(normalized).toLowerCase();
    }
    if (this.blindIndexService) {
      return this.blindIndexService.generateIndex(normalized).toLowerCase();
    }

    throw new JudicialProtectionEngineError(
      "DESCONOCIDO",
      "servicio criptográfico de blind index no disponible",
    );
  }

  resolveDocumentHash(
    documento?: string | null,
    explicitHash?: string | null,
  ): string {
    const trimmedDoc = documento?.trim();
    const trimmedHash = explicitHash?.trim().toLowerCase();

    if (trimmedDoc) {
      const derived = this.computeRestrictedDocumentHash(trimmedDoc);
      if (trimmedHash && trimmedHash !== derived) {
        throw new InvalidJudicialAlertDocumentError(
          "El documento digitado y el documento_restringido_hash suministrado no coinciden.",
        );
      }
      return derived;
    }

    if (trimmedHash && BLIND_INDEX_HEX_RE.test(trimmedHash)) {
      return trimmedHash;
    }

    throw new InvalidJudicialAlertDocumentError(
      "Se requiere documento_receptor o un documento_restringido_hash HMAC-SHA256 válido de 64 caracteres hexadecimales.",
    );
  }

  async createAlert(
    dto: CreateJudicialAlertDto,
    registradoPorUsuarioId: string,
  ): Promise<JudicialAlertDecryptedView> {
    try {
      const normalizedDoc = normalizeDocument(
        dto.individuo_restringido_documento,
      );
      const blindIndex = this.computeRestrictedDocumentHash(normalizedDoc);

      const nombreCifrado = this.cryptoVault.encrypt(
        dto.individuo_restringido_nombre.trim(),
      );
      const documentoCifrado = this.cryptoVault.encrypt(normalizedDoc);
      const resumenCifrado = this.cryptoVault.encrypt(
        dto.orden_judicial_resumen.trim(),
      );
      const fotoCifrada = this.cryptoVault.encrypt(
        dto.foto_individuo_referencia?.trim() ||
          DEFAULT_ENCRYPTED_PHOTO_PLACEHOLDER,
      );

      const hashIntegridad = this.hashService.sha256(
        [
          dto.id_estudiante,
          dto.juzgado_emisor.trim(),
          dto.radicado_medida.trim(),
          blindIndex,
          registradoPorUsuarioId,
        ].join("|"),
      );

      const created = await this.repository.create({
        id_estudiante: dto.id_estudiante,
        juzgado_emisor: dto.juzgado_emisor.trim(),
        radicado_medida: dto.radicado_medida.trim(),
        foto_individuo_cifrada: fotoCifrada,
        individuo_restringido_nombre_cifrado: nombreCifrado,
        individuo_restringido_documento_cifrado: documentoCifrado,
        individuo_blind_index: blindIndex,
        orden_judicial_resumen_cifrado: resumenCifrado,
        registrado_por_rectoria: registradoPorUsuarioId,
        hash_integridad_sha256: hashIntegridad,
      });

      if (this.auditService) {
        await this.auditService.logCriticalEvent({
          tipo_evento: "ALERTA_JUDICIAL_REGISTRADA",
          id_usuario: registradoPorUsuarioId,
          id_estudiante: created.id_estudiante,
          payload: {
            id_alerta: created.id_alerta,
            radicado_medida: created.radicado_medida,
            juzgado_emisor: created.juzgado_emisor,
            documento_restringido_hash: created.documento_restringido_hash,
            hash_integridad_sha256: created.hash_integridad_sha256,
          },
        });
      }

      return this.toDecryptedView(created);
    } catch (error) {
      this.rethrowAsHttpException(error);
    }
  }

  async listStudentAlerts(
    idEstudiante: string,
    includeInactive = false,
  ): Promise<JudicialAlertDecryptedView[]> {
    const records = await this.repository.listByStudent(
      idEstudiante,
      includeInactive,
    );
    return records.map((record) => this.toDecryptedView(record));
  }

  /**
   * Consulta determinista en modo fail-safe para el motor de interceptación en desembarque.
   * Si ocurre un error técnico inesperado, lanza `JudicialProtectionEngineError` (bloqueo seguro).
   */
  async findActiveRestrictionByHash(
    idEstudiante: string,
    documentoRestringidoHash: string,
  ): Promise<ActiveJudicialAlertMatch | null> {
    const normalizedHash = documentoRestringidoHash?.trim().toLowerCase();
    if (!normalizedHash || !BLIND_INDEX_HEX_RE.test(normalizedHash)) {
      throw new InvalidJudicialAlertDocumentError(
        "El blind index del receptor debe ser un hash HMAC-SHA256 válido de 64 caracteres hexadecimales.",
      );
    }

    try {
      return await this.repository.findActiveMatchByBlindIndex(
        idEstudiante,
        normalizedHash,
      );
    } catch (error) {
      if (error instanceof InvalidJudicialAlertDocumentError) {
        throw error;
      }
      throw new JudicialProtectionEngineError(
        idEstudiante,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async verifyRestriction(
    dto: VerifyJudicialAlertDto,
    consultadoPorUsuarioId?: string | null,
  ): Promise<JudicialAlertVerificationResponse> {
    try {
      const hash = this.resolveDocumentHash(
        dto.documento_receptor,
        dto.documento_restringido_hash,
      );
      const match = await this.findActiveRestrictionByHash(
        dto.id_estudiante,
        hash,
      );

      if (match) {
        if (this.auditService) {
          await this.auditService.logCriticalEvent({
            tipo_evento: "ALERTA_JUDICIAL_CONSULTA_COINCIDENCIA",
            id_usuario: consultadoPorUsuarioId ?? undefined,
            id_estudiante: dto.id_estudiante,
            payload: {
              codigo: JUDICIAL_BLOCKING_CODE,
              id_alerta: match.id_alerta,
              radicado_medida: match.radicado_medida,
              juzgado_emisor: match.juzgado_emisor,
            },
          });
        }

        return {
          bloqueada: true,
          codigo: JUDICIAL_BLOCKING_CODE,
          id_estudiante: dto.id_estudiante,
          documento_restringido_hash: hash,
          id_alerta: match.id_alerta,
          radicado_medida: match.radicado_medida,
          juzgado_emisor: match.juzgado_emisor,
          fecha_registro: match.fecha_registro.toISOString(),
          mensaje: `${JUDICIAL_BLOCKING_CODE}: Prohibida la entrega del menor; existe medida cautelar judicial activa (radicado ${match.radicado_medida}).`,
        };
      }

      return {
        bloqueada: false,
        codigo: "SIN_RESTRICCION_JUDICIAL",
        id_estudiante: dto.id_estudiante,
        documento_restringido_hash: hash,
        id_alerta: null,
        radicado_medida: null,
        juzgado_emisor: null,
        fecha_registro: null,
        mensaje:
          "Sin alerta judicial activa para el documento consultado sobre este estudiante.",
      };
    } catch (error) {
      this.rethrowAsHttpException(error);
    }
  }

  async deactivateAlert(
    idAlerta: string,
    dto: DeactivateJudicialAlertDto,
    usuarioId: string,
  ): Promise<JudicialAlertDecryptedView> {
    try {
      const updated = await this.repository.deactivateSoft({
        id_alerta: idAlerta,
        eliminado_por_coordinacion: dto.eliminado_por_coordinacion ?? null,
        autorizado_excepcion_por: dto.autorizado_excepcion_por?.trim() || null,
      });

      if (this.auditService) {
        await this.auditService.logCriticalEvent({
          tipo_evento: "ALERTA_JUDICIAL_DESACTIVADA",
          id_usuario: usuarioId,
          id_estudiante: updated.id_estudiante,
          payload: {
            id_alerta: updated.id_alerta,
            radicado_medida: updated.radicado_medida,
            eliminado_por_coordinacion: updated.eliminado_por_coordinacion,
            autorizado_excepcion_por: updated.autorizado_excepcion_por,
          },
        });
      }

      return this.toDecryptedView(updated);
    } catch (error) {
      this.rethrowAsHttpException(error);
    }
  }

  async recordEmergencyIncidentInStore(
    input: RecordJudicialEmergencyIncidentInput,
  ): Promise<RecordJudicialEmergencyIncidentResult | null> {
    if (!this.repository.recordJudicialBlockIncidentAndNotifications) {
      return null;
    }
    return this.repository.recordJudicialBlockIncidentAndNotifications(input);
  }

  private toDecryptedView(
    record: StoredJudicialAlert,
  ): JudicialAlertDecryptedView {
    const nombre = this.cryptoVault.decrypt(
      record.individuo_restringido_nombre_cifrado,
    );
    const documento = this.cryptoVault.decrypt(
      record.individuo_restringido_documento_cifrado,
    );
    const resumen = this.cryptoVault.decrypt(
      record.orden_judicial_resumen_cifrado,
    );
    const foto = this.cryptoVault.decrypt(record.foto_individuo_cifrada);

    return {
      id_alerta: record.id_alerta,
      id_estudiante: record.id_estudiante,
      juzgado_emisor: record.juzgado_emisor,
      radicado_medida: record.radicado_medida,
      individuo_restringido_nombre: nombre,
      individuo_restringido_documento_enmascarado: this.maskDocument(documento),
      documento_restringido_hash: record.documento_restringido_hash,
      orden_judicial_resumen: resumen,
      foto_individuo_referencia: foto,
      activa: record.activa,
      eliminado_soft: record.eliminado_soft,
      fecha_registro: record.fecha_registro.toISOString(),
      registrado_por_rectoria: record.registrado_por_rectoria,
      eliminado_en: record.eliminado_en
        ? record.eliminado_en.toISOString()
        : null,
      eliminado_por_coordinacion: record.eliminado_por_coordinacion,
      autorizado_excepcion_por: record.autorizado_excepcion_por,
      hash_integridad_sha256: record.hash_integridad_sha256,
    };
  }

  private maskDocument(documento: string): string {
    if (documento.length <= 4) {
      return "*".repeat(documento.length);
    }
    return `${"*".repeat(documento.length - 4)}${documento.slice(-4)}`;
  }

  private rethrowAsHttpException(error: unknown): never {
    if (error instanceof JudicialAlertNotFoundError) {
      throw new NotFoundException({
        code: error.code,
        error: error.code,
        message: error.message,
      });
    }
    if (
      error instanceof DuplicateJudicialAlertRadicadoError ||
      error instanceof JudicialAlertAlreadyDeactivatedError
    ) {
      throw new ConflictException({
        code: error.code,
        error: error.code,
        message: error.message,
      });
    }
    if (error instanceof InvalidJudicialAlertDocumentError) {
      throw new BadRequestException({
        code: error.code,
        error: error.code,
        message: error.message,
      });
    }
    throw error;
  }
}
