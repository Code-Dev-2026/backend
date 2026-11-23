import { Injectable } from "@nestjs/common";
import { StudentRecord } from "../domain/student.entity";
import {
  DuplicateStudentError,
  IStudentRepository,
  StudentPage,
} from "../domain/student.repository";

/**
 * Adaptador TEMPORAL en memoria de IStudentRepository (arranca vacío).
 * Guarda exactamente lo que guardaría PostgreSQL: solo texto cifrado e
 * índices ciegos. Se reemplaza cambiando el provider STUDENT_REPOSITORY.
 */
@Injectable()
export class InMemoryStudentRepository implements IStudentRepository {
  private readonly students = new Map<string, StudentRecord>();

  async save(record: StudentRecord): Promise<void> {
    for (const existing of this.students.values()) {
      if (existing.documento_blind_index === record.documento_blind_index) {
        throw new DuplicateStudentError("documento");
      }
      if (existing.codigo_institucional === record.codigo_institucional) {
        throw new DuplicateStudentError("codigo_institucional");
      }
    }
    this.students.set(record.id_estudiante, { ...record });
  }

  async findById(idEstudiante: string): Promise<StudentRecord | null> {
    const record = this.students.get(idEstudiante);
    return record ? { ...record } : null;
  }

  async findByBlindIndex(blindIndex: string): Promise<StudentRecord | null> {
    for (const record of this.students.values()) {
      if (record.documento_blind_index === blindIndex) {
        return { ...record };
      }
    }
    return null;
  }

  async list(offset: number, limit: number): Promise<StudentPage> {
    const all = [...this.students.values()].sort((a, b) =>
      a.id_estudiante.localeCompare(b.id_estudiante),
    );
    return {
      items: all.slice(offset, offset + limit).map((r) => ({ ...r })),
      total: all.length,
    };
  }

  /** Solo para pruebas: lo que quedó guardado "en la base de datos". */
  dump(): StudentRecord[] {
    return [...this.students.values()].map((r) => ({ ...r }));
  }
}
