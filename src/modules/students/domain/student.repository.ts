import { StudentRecord } from "./student.entity";

export interface StudentPage {
  items: StudentRecord[];
  total: number;
}

/**
 * Puerto de persistencia de estudiantes (DIP).
 * Solo recibe y devuelve registros cifrados: el adaptador SQL nunca ve
 * datos personales en claro.
 */
export interface IStudentRepository {
  /** Inserta; falla con DuplicateStudentError si el documento o el código ya existen. */
  save(record: StudentRecord): Promise<void>;
  findById(idEstudiante: string): Promise<StudentRecord | null>;
  /** Búsqueda exacta por índice ciego (WHERE documento_blind_index = $1). */
  findByBlindIndex(blindIndex: string): Promise<StudentRecord | null>;
  list(offset: number, limit: number): Promise<StudentPage>;
}

export class DuplicateStudentError extends Error {
  constructor(readonly field: "documento" | "codigo_institucional") {
    super(`Estudiante duplicado por ${field}.`);
  }
}

export const STUDENT_REPOSITORY = Symbol("IStudentRepository");
