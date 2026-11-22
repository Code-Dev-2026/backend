import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { CryptoVaultService } from "@common/crypto/crypto-vault.service";
import { AuthenticatedUser } from "@common/decorators/current-user.decorator";
import { AuditService } from "../audit/audit.service";
import {
  NewStudentData,
  Student,
  StudentExpediente,
  StudentSummary,
} from "./domain/student.entity";
import {
  DuplicateStudentError,
  IStudentRepository,
  STUDENT_REPOSITORY,
} from "./domain/student.repository";
import { assertExpedienteAccess } from "./students.permissions";

export { EXPEDIENTE_ROLES } from "./students.permissions";

export interface StudentListResult {
  items: StudentSummary[];
  total: number;
  offset: number;
  limit: number;
}

/**
 * Expedientes de estudiantes (Ley 1581 — datos de menores).
 * - Persiste solo texto cifrado (AES-256-GCM) e índice ciego (HMAC-SHA256).
 * - Descifra únicamente en memoria y solo para un usuario autenticado con
 *   rol administrativo y MFA verificado (se revalida aquí además del guard).
 * - Cada acceso queda en la bitácora forense SIN datos personales.
 */
@Injectable()
export class StudentsService {
  constructor(
    @Inject(STUDENT_REPOSITORY)
    private readonly repository: IStudentRepository,
    private readonly vault: CryptoVaultService,
    private readonly audit: AuditService,
  ) {}

  async create(
    data: NewStudentData,
    actor: AuthenticatedUser | undefined,
  ): Promise<StudentExpediente> {
    const user = this.assertCanAccess(actor);
    const record = Student.create(data, this.vault);

    try {
      await this.repository.save(record);
    } catch (error) {
      if (error instanceof DuplicateStudentError) {
        throw new ConflictException(
          error.field === "documento"
            ? "Ya existe un estudiante con ese documento."
            : "Ya existe un estudiante con ese código institucional.",
        );
      }
      throw error;
    }

    await this.registrar("EXPEDIENTE_CREADO", user, record.id_estudiante);
    return Student.toExpediente(record, this.vault);
  }

  async getExpediente(
    idEstudiante: string,
    actor: AuthenticatedUser | undefined,
  ): Promise<StudentExpediente> {
    const user = this.assertCanAccess(actor);
    const record = await this.repository.findById(idEstudiante);
    if (!record) {
      throw new NotFoundException("Estudiante no encontrado.");
    }

    await this.registrar("EXPEDIENTE_CONSULTADO", user, record.id_estudiante);
    return Student.toExpediente(record, this.vault);
  }

  /** Búsqueda exacta por documento sobre `documento_blind_index`. */
  async findByDocument(
    documento: string,
    actor: AuthenticatedUser | undefined,
  ): Promise<StudentExpediente> {
    const user = this.assertCanAccess(actor);
    const blindIndex = Student.blindIndex(documento, this.vault);
    const record = await this.repository.findByBlindIndex(blindIndex);

    await this.registrar(
      "EXPEDIENTE_BUSQUEDA_DOCUMENTO",
      user,
      record?.id_estudiante,
      { encontrado: Boolean(record) },
    );

    if (!record) {
      throw new NotFoundException("No hay un estudiante con ese documento.");
    }
    return Student.toExpediente(record, this.vault);
  }

  async list(
    offset: number,
    limit: number,
    actor: AuthenticatedUser | undefined,
  ): Promise<StudentListResult> {
    const user = this.assertCanAccess(actor);
    const page = await this.repository.list(offset, limit);

    await this.registrar("EXPEDIENTES_LISTADOS", user, undefined, {
      offset,
      limit,
      cantidad: page.items.length,
    });

    return {
      items: page.items.map((r) => Student.toSummary(r, this.vault)),
      total: page.total,
      offset,
      limit,
    };
  }

  /** Defensa en profundidad: nada se descifra sin rol y MFA suficientes. */
  private assertCanAccess(actor: AuthenticatedUser | undefined) {
    return assertExpedienteAccess(actor);
  }

  private registrar(
    tipo_evento: string,
    actor: AuthenticatedUser,
    id_estudiante?: string,
    payload: Record<string, unknown> = {},
  ) {
    return this.audit.logCriticalEvent({
      tipo_evento,
      id_usuario: actor.id_usuario,
      id_estudiante,
      payload,
    });
  }
}
