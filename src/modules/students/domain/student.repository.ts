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

  /**
   * Ejecuta `work` dentro de UNA transacción. Si `work` lanza cualquier
   * error se hace ROLLBACK integral; si termina bien, COMMIT.
   * En PostgreSQL equivale a QueryRunner: connect -> startTransaction ->
   * commitTransaction | rollbackTransaction -> release.
   */
  transaction<T>(work: (tx: StudentWriteTransaction) => Promise<T>): Promise<T>;
}

/** Operaciones disponibles dentro de una transacción de escritura. */
export interface StudentWriteTransaction {
  /** Índices ciegos que ya existen (en BD o insertados en esta transacción). */
  findExistingBlindIndexes(indexes: string[]): Promise<Set<string>>;
  findExistingCodigos(codigos: string[]): Promise<Set<string>>;
  /**
   * Inserta un lote. Lanza DuplicateStudentError (UNIQUE) o
   * ForeignKeyViolationError (FK id_colegio); cualquiera aborta la transacción.
   */
  insertMany(records: StudentRecord[]): Promise<void>;
}

/** Violación de llave foránea (SQLSTATE 23503), p. ej. id_colegio inexistente. */
export class ForeignKeyViolationError extends Error {
  constructor(readonly constraint: string) {
    super(`Violación de llave foránea: ${constraint}.`);
  }
}

export class DuplicateStudentError extends Error {
  constructor(readonly field: "documento" | "codigo_institucional") {
    super(`Estudiante duplicado por ${field}.`);
  }
}

export const STUDENT_REPOSITORY = Symbol("IStudentRepository");
