import { Injectable } from "@nestjs/common";
import { StudentRecord } from "../domain/student.entity";
import {
  DuplicateStudentError,
  IStudentRepository,
  StudentPage,
  StudentWriteTransaction,
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
    this.assertUnique([record]);
    this.students.set(record.id_estudiante, { ...record });
  }

  /**
   * Transacción simulada: las escrituras van a un área de staging que solo
   * se vuelca a la "tabla" en el COMMIT (de forma síncrona, sin awaits, por
   * lo que es atómica en el event loop). Si `work` falla, se descarta
   * entera (ROLLBACK) y la tabla queda exactamente como estaba.
   */
  async transaction<T>(
    work: (tx: StudentWriteTransaction) => Promise<T>,
  ): Promise<T> {
    const staged: StudentRecord[] = [];
    const committed = () => [...this.students.values(), ...staged];

    const tx: StudentWriteTransaction = {
      findExistingBlindIndexes: async (indexes) => {
        const wanted = new Set(indexes);
        return new Set(
          committed()
            .map((r) => r.documento_blind_index)
            .filter((i) => wanted.has(i)),
        );
      },
      findExistingCodigos: async (codigos) => {
        const wanted = new Set(codigos);
        return new Set(
          committed()
            .map((r) => r.codigo_institucional)
            .filter((c) => wanted.has(c)),
        );
      },
      insertMany: async (records) => {
        this.assertUnique(records, staged);
        staged.push(...records.map((r) => ({ ...r })));
      },
    };

    const result = await work(tx); // si lanza: ROLLBACK (staging descartado)

    // COMMIT: revalida contra lo confirmado por otras transacciones
    this.assertUnique(staged);
    for (const record of staged) {
      this.students.set(record.id_estudiante, record);
    }
    return result;
  }

  /** Simula las restricciones UNIQUE de documento_blind_index y código. */
  private assertUnique(
    records: StudentRecord[],
    extra: StudentRecord[] = [],
  ): void {
    const indexes = new Set<string>();
    const codigos = new Set<string>();
    for (const r of [...this.students.values(), ...extra]) {
      indexes.add(r.documento_blind_index);
      codigos.add(r.codigo_institucional);
    }
    for (const r of records) {
      if (indexes.has(r.documento_blind_index)) {
        throw new DuplicateStudentError("documento");
      }
      if (codigos.has(r.codigo_institucional)) {
        throw new DuplicateStudentError("codigo_institucional");
      }
      indexes.add(r.documento_blind_index);
      codigos.add(r.codigo_institucional);
    }
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
