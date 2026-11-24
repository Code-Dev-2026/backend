import { Inject, Injectable, Optional } from "@nestjs/common";
import { BlindIndexService } from "@common/crypto/blind-index.service";
import { CryptoVaultService } from "@common/crypto/crypto-vault.service";
import { normalizeDocument } from "../students/domain/student.entity";
import {
  ATTENDANCE_REPOSITORY,
  IAttendanceRepository,
} from "./domain/attendance-repository.port";
import {
  AuthorizationExpiredError,
  AuthorizedAdultsLimitExceededError,
  CoordinatorUnauthorizedError,
  IncompatibleTripDirectionError,
  JudicialAlertBlockedError,
  MAX_ACTIVE_AUTHORIZED_ADULTS,
  ReceptorInactiveOrRevokedError,
  ReceptorType,
  ReceptorUnauthorizedError,
  StudentNotFoundError,
  ValidatedCoordinatorResult,
  ValidatedReceptorResult,
} from "./domain/disembark.types";

export interface ValidateDeliveryReceptorInput {
  id_estudiante: string;
  tipo_receptor: ReceptorType;
  documento_receptor?: string | null;
  documento_blind_index?: string | null;
  id_receptor?: string | null;
  tipo_recorrido: "MANANA" | "TARDE";
  now?: Date;
}

export interface ValidateSchoolCoordinatorInput {
  id_estudiante: string;
  id_coordinador: string;
}

/**
 * Servicio SRP responsable exclusivamente de verificar la potestad legal y operativa
 * del receptor de entrega de un menor (Issue #9: RF-09, RN-04, OWASP ASVS V4.1).
 *
 * Principio Fail-Safe:
 * - Ante cualquier ausencia de acreditación, ambigüedad, vencimiento, revocatoria,
 *   desfase de identidad, exceso sobre el límite RN-04 (máx. 3 autorizados activos)
 *   o alerta judicial activa, la validación rechaza estrictamente la entrega.
 * - La identidad del receptor se coteja únicamente contra `documento_blind_index`
 *   (HMAC-SHA256) sin persistir ni comparar documentos en texto plano en la BD.
 */
@Injectable()
export class DeliveryValidationService {
  constructor(
    @Inject(ATTENDANCE_REPOSITORY)
    private readonly repository: IAttendanceRepository,
    @Optional() private readonly cryptoVault?: CryptoVaultService,
    @Optional() private readonly blindIndexService?: BlindIndexService,
  ) {}

  /**
   * Normaliza el documento de identidad y deriva su índice ciego determinista (HMAC-SHA256).
   */
  computeDocumentBlindIndex(documento: string): string {
    const normalized = normalizeDocument(documento ?? "");
    if (!normalized) {
      throw new ReceptorUnauthorizedError(
        "DESCONOCIDO",
        "El documento del receptor es obligatorio para verificar su identidad.",
      );
    }

    if (this.cryptoVault) {
      return this.cryptoVault.generateBlindIndex(normalized).toLowerCase();
    }
    if (this.blindIndexService) {
      return this.blindIndexService.generateIndex(normalized).toLowerCase();
    }

    throw new ReceptorUnauthorizedError(
      "DESCONOCIDO",
      "Servicio criptográfico de blind index no disponible; entrega bloqueada de forma segura.",
    );
  }

  /**
   * Resuelve el blind index normalizado a partir de un documento en claro o un blind index ya derivado.
   */
  resolveBlindIndex(
    documento?: string | null,
    explicitBlindIndex?: string | null,
  ): string | null {
    const trimmedDoc = documento?.trim();
    const trimmedIdx = explicitBlindIndex?.trim().toLowerCase();

    if (trimmedDoc) {
      const derived = this.computeDocumentBlindIndex(trimmedDoc);
      // Fail-safe: si llegan ambos, deben coincidir exactamente
      if (trimmedIdx && trimmedIdx !== derived) {
        return null;
      }
      return derived;
    }

    if (trimmedIdx && /^[a-f0-9]{64}$/.test(trimmedIdx)) {
      return trimmedIdx;
    }

    return null;
  }

  /**
   * Valida de forma independiente para un único estudiante si el receptor cuenta con potestad vigente.
   * Mitigación de riesgo de hermanos/emparentados: la comprobación se acota estrictamente a `id_estudiante`.
   */
  async validateReceptorForDelivery(
    input: ValidateDeliveryReceptorInput,
  ): Promise<ValidatedReceptorResult> {
    const now = input.now ?? new Date();
    const directory = await this.repository.getStudentReceptorDirectory(
      input.id_estudiante,
    );

    if (!directory || !directory.activo) {
      throw new StudentNotFoundError(input.id_estudiante);
    }

    const activeAuthorizedCount = directory.autorizados.filter(
      (auth) =>
        auth.autorizacion_activa &&
        auth.adulto_activo &&
        !auth.expediente_revocado &&
        (auth.autorizado_hasta === null || auth.autorizado_hasta > now),
    ).length;

    // 1. Entrega institucional en colegio (SEDE_EDUCATIVA)
    if (input.tipo_receptor === ReceptorType.SEDE_EDUCATIVA) {
      if (input.tipo_recorrido !== "MANANA") {
        throw new IncompatibleTripDirectionError(
          "La entrega directa en SEDE_EDUCATIVA solo aplica en recorridos de MANANA. Para cerrar un retorno seguro en TARDE utilice /asistencia/custodia/finalizar-sede.",
        );
      }

      return {
        autorizado: true,
        tipo_receptor: ReceptorType.SEDE_EDUCATIVA,
        id_acudiente: null,
        id_autorizado: null,
        documento_blind_index: null,
        nombre_receptor: "Sede Educativa Institucional",
        parentesco: "INSTITUCION_EDUCATIVA",
        autorizados_activos_estudiante: activeAuthorizedCount,
      };
    }

    // 2. Entrega a ACUDIENTE o ADULTO_AUTORIZADO (solo recorrido TARDE)
    if (input.tipo_recorrido !== "TARDE") {
      throw new IncompatibleTripDirectionError(
        `La entrega a '${input.tipo_receptor}' solo aplica en recorridos de TARDE.`,
      );
    }

    const blindIndex = this.resolveBlindIndex(
      input.documento_receptor,
      input.documento_blind_index,
    );

    if (!blindIndex) {
      throw new ReceptorUnauthorizedError(
        input.id_estudiante,
        "Identidad del receptor ausente o inconsistente: se requiere documento o blind index SHA-256 válido.",
      );
    }

    // 3. Prioridad absoluta de seguridad: bloqueo inmediato por alerta judicial activa (RF-07 / ASVS V4.1)
    const judicialAlert = directory.alertas_judiciales.find(
      (alert) =>
        alert.activa &&
        !alert.eliminado_soft &&
        alert.individuo_blind_index.toLowerCase() === blindIndex,
    );

    if (judicialAlert) {
      throw new JudicialAlertBlockedError(
        input.id_estudiante,
        judicialAlert.radicado_medida,
      );
    }

    // 4. Validación de ACUDIENTE titular vinculado a ESTE estudiante
    if (input.tipo_receptor === ReceptorType.ACUDIENTE) {
      const guardian = directory.acudientes.find(
        (g) =>
          g.documento_blind_index.toLowerCase() === blindIndex &&
          (!input.id_receptor || g.id_acudiente === input.id_receptor),
      );

      if (!guardian) {
        throw new ReceptorUnauthorizedError(
          input.id_estudiante,
          `El acudiente no está acreditado en el expediente del estudiante '${input.id_estudiante}'.`,
        );
      }

      return {
        autorizado: true,
        tipo_receptor: ReceptorType.ACUDIENTE,
        id_acudiente: guardian.id_acudiente,
        id_autorizado: null,
        documento_blind_index: blindIndex,
        nombre_receptor: `${guardian.nombres} ${guardian.apellidos}`.trim(),
        parentesco: guardian.parentesco,
        autorizados_activos_estudiante: activeAuthorizedCount,
      };
    }

    // 5. Validación de ADULTO_AUTORIZADO (RN-04: máx. 3 activos + autorización vigente no vencida ni revocada)
    if (input.tipo_receptor === ReceptorType.ADULTO_AUTORIZADO) {
      // Defensa RN-04: si existen > 3 autorizados activos por anomalía de datos, bloquear de forma segura
      if (activeAuthorizedCount > MAX_ACTIVE_AUTHORIZED_ADULTS) {
        throw new AuthorizedAdultsLimitExceededError(
          input.id_estudiante,
          activeAuthorizedCount,
        );
      }

      const authorized = directory.autorizados.find(
        (a) =>
          a.documento_blind_index.toLowerCase() === blindIndex &&
          (!input.id_receptor || a.id_autorizado === input.id_receptor),
      );

      if (!authorized) {
        throw new ReceptorUnauthorizedError(
          input.id_estudiante,
          `El adulto receptor no figura como autorizado para el estudiante '${input.id_estudiante}'.`,
        );
      }

      if (
        !authorized.adulto_activo ||
        !authorized.autorizacion_activa ||
        authorized.expediente_revocado
      ) {
        throw new ReceptorInactiveOrRevokedError(input.id_estudiante);
      }

      if (authorized.autorizado_hasta && authorized.autorizado_hasta <= now) {
        throw new AuthorizationExpiredError(
          input.id_estudiante,
          authorized.autorizado_hasta,
        );
      }

      return {
        autorizado: true,
        tipo_receptor: ReceptorType.ADULTO_AUTORIZADO,
        id_acudiente: null,
        id_autorizado: authorized.id_autorizado,
        documento_blind_index: blindIndex,
        nombre_receptor: `${authorized.nombres} ${authorized.apellidos}`.trim(),
        parentesco: authorized.parentesco,
        autorizados_activos_estudiante: activeAuthorizedCount,
      };
    }

    // Fail-safe por defecto ante cualquier tipo desconocido
    throw new ReceptorUnauthorizedError(
      input.id_estudiante,
      `Tipo de receptor no reconocido: '${String(input.tipo_receptor)}'.`,
    );
  }

  /**
   * Valida que el coordinador receptor pertenezca al mismo colegio del estudiante (ASVS V4.1).
   */
  async validateSchoolCoordinator(
    input: ValidateSchoolCoordinatorInput,
  ): Promise<ValidatedCoordinatorResult> {
    const directory = await this.repository.getStudentReceptorDirectory(
      input.id_estudiante,
    );

    if (!directory || !directory.activo) {
      throw new StudentNotFoundError(input.id_estudiante);
    }

    const coordinator = await this.repository.getSchoolCoordinator(
      input.id_coordinador,
    );

    if (
      !coordinator ||
      (directory.id_colegio && coordinator.id_colegio !== directory.id_colegio)
    ) {
      throw new CoordinatorUnauthorizedError(
        input.id_coordinador,
        input.id_estudiante,
      );
    }

    return {
      id_coordinador: coordinator.id_coordinador,
      id_colegio: coordinator.id_colegio,
      nombre_completo: `${coordinator.nombres} ${coordinator.apellidos}`.trim(),
      cargo: coordinator.cargo,
    };
  }
}
