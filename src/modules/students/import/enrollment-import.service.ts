import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CryptoVaultService } from "@common/crypto/crypto-vault.service";
import { HashService } from "@common/crypto/hash.service";
import { AuthenticatedUser } from "@common/decorators/current-user.decorator";
import { AuditService } from "../../audit/audit.service";
import { SchoolsService } from "../../schools/schools.service";
import { Student, StudentRecord } from "../domain/student.entity";
import {
  DuplicateStudentError,
  ForeignKeyViolationError,
  IStudentRepository,
  STUDENT_REPOSITORY,
  StudentWriteTransaction,
} from "../domain/student.repository";
import { ImportStudentRowDto } from "../dto/student.dto";
import { assertExpedienteAccess } from "../students.permissions";
import {
  EnrollmentFileFormatError,
  EnrollmentFileKind,
  RawRow,
  readEnrollmentRows,
} from "./enrollment-file-reader";
import { IImportLedger, IMPORT_LEDGER } from "./import-ledger";

export const IMPORT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const IMPORT_BATCH_SIZE = 100;
export const IMPORT_MAX_ROWS = 5_000;
/** Tope de observaciones devueltas (el conteo total sigue siendo exacto). */
export const IMPORT_MAX_ISSUES = 500;

const REQUIRED_COLUMNS = [
  "codigo_institucional",
  "nombre_completo",
  "documento_identidad",
  "direccion",
  "grado",
] as const;
const OPTIONAL_COLUMNS = ["condiciones_medicas"] as const;
const KNOWN_COLUMNS = new Set<string>([
  ...REQUIRED_COLUMNS,
  ...OPTIONAL_COLUMNS,
]);

/** Encabezados alternativos frecuentes en las plantillas de los colegios. */
const COLUMN_ALIASES: Record<string, string> = {
  codigo: "codigo_institucional",
  nombre: "nombre_completo",
  nombres_y_apellidos: "nombre_completo",
  documento: "documento_identidad",
  numero_documento: "documento_identidad",
  condiciones_medicas_relevantes: "condiciones_medicas",
};

const MIME_BY_KIND: Record<EnrollmentFileKind, string[]> = {
  // Windows/Excel suele enviar los CSV como application/vnd.ms-excel
  CSV: [
    "text/csv",
    "application/csv",
    "text/plain",
    "application/vnd.ms-excel",
  ],
  XLSX: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/octet-stream",
  ],
};

export interface UploadedEnrollmentFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface RowIssue {
  /** Número de fila en el archivo (1 = encabezado). 0 = archivo completo. */
  fila: number;
  campo?: string;
  mensaje: string;
}

export interface ImportBalance {
  estado: "COMPLETADA" | "REVERTIDA";
  archivo: {
    nombre: string;
    tipo: EnrollmentFileKind;
    tamano_bytes: number;
    hash_sha256: string;
  };
  id_colegio: string;
  total_filas: number;
  filas_procesadas: number;
  filas_validas: number;
  creadas: number;
  total_errores: number;
  errores: RowIssue[];
  advertencias: RowIssue[];
}

export interface ImportOutcome {
  httpStatus: HttpStatus;
  balance: ImportBalance;
}

/** Señal interna para abortar la transacción y forzar el ROLLBACK. */
class RollbackSignal extends Error {}

/**
 * Importación masiva de matrículas (CSV / XLSX).
 * 1. Valida tipo y contenido del archivo (el tamaño lo limita multer).
 * 2. Idempotencia: SHA-256 del contenido reservado en `importacion_matricula`;
 *    un archivo ya cargado (o en proceso) se rechaza con 409.
 * 3. Lee por stream en lotes de 100, valida cada fila con class-validator,
 *    detecta duplicados dentro del archivo y contra la base de datos.
 * 4. Todo se inserta en UNA transacción: cualquier error de fila, de
 *    UNIQUE o de llave foránea provoca ROLLBACK integral (0 filas creadas).
 * 5. Devuelve un balance con conteos y observaciones por fila (sin PII).
 */
@Injectable()
export class EnrollmentImportService {
  constructor(
    @Inject(STUDENT_REPOSITORY)
    private readonly repository: IStudentRepository,
    @Inject(IMPORT_LEDGER) private readonly ledger: IImportLedger,
    private readonly vault: CryptoVaultService,
    private readonly hashService: HashService,
    private readonly schools: SchoolsService,
    private readonly audit: AuditService,
  ) {}

  async import(
    file: UploadedEnrollmentFile | undefined,
    idColegio: string,
    actor: AuthenticatedUser | undefined,
  ): Promise<ImportOutcome> {
    const user = assertExpedienteAccess(actor);
    if (!file?.buffer?.length) {
      throw new BadRequestException(
        "Debe adjuntar un archivo CSV o XLSX en el campo 'file'.",
      );
    }
    if (file.size > IMPORT_MAX_BYTES) {
      throw new BadRequestException("El archivo supera el tamaño máximo.");
    }
    const kind = this.detectKind(file);
    const hash = this.hashService.sha256Buffer(file.buffer);

    const balance: ImportBalance = {
      estado: "REVERTIDA",
      archivo: {
        nombre: file.originalname.slice(0, 255),
        tipo: kind,
        tamano_bytes: file.size,
        hash_sha256: hash,
      },
      id_colegio: idColegio,
      total_filas: 0,
      filas_procesadas: 0,
      filas_validas: 0,
      creadas: 0,
      total_errores: 0,
      errores: [],
      advertencias: [],
    };

    const reservation = await this.ledger.reserve({
      hash_sha256: hash,
      estado: "EN_PROCESO",
      id_usuario: user.id_usuario,
      id_colegio: idColegio,
      tipo_archivo: kind,
      tamano_bytes: file.size,
      filas_creadas: 0,
      creado_en: new Date(),
      completado_en: null,
    });
    if (!reservation.reserved) {
      throw new ConflictException({
        message:
          reservation.existing.estado === "COMPLETADA"
            ? "Este archivo de matrícula ya fue importado."
            : "Este archivo de matrícula se está importando en este momento.",
        hash_sha256: hash,
        importado_en: reservation.existing.completado_en?.toISOString(),
      });
    }

    try {
      await this.runImport(file.buffer, kind, idColegio, balance);
    } catch (error) {
      await this.ledger.release(hash);
      throw error;
    }

    if (balance.estado === "COMPLETADA") {
      await this.ledger.complete(hash, balance.creadas);
    } else {
      await this.ledger.release(hash);
    }

    await this.audit.logCriticalEvent({
      tipo_evento:
        balance.estado === "COMPLETADA"
          ? "IMPORTACION_MATRICULAS_COMPLETADA"
          : "IMPORTACION_MATRICULAS_REVERTIDA",
      id_usuario: user.id_usuario,
      payload: {
        hash_sha256: hash,
        id_colegio: idColegio,
        tipo_archivo: kind,
        total_filas: balance.total_filas,
        creadas: balance.creadas,
        total_errores: balance.total_errores,
      },
    });

    return {
      httpStatus:
        balance.estado === "COMPLETADA"
          ? HttpStatus.CREATED
          : HttpStatus.UNPROCESSABLE_ENTITY,
      balance,
    };
  }

  private async runImport(
    buffer: Buffer,
    kind: EnrollmentFileKind,
    idColegio: string,
    balance: ImportBalance,
  ): Promise<void> {
    // Llave foránea id_colegio: se verifica antes de abrir la transacción.
    try {
      await this.schools.findById(idColegio);
    } catch (error) {
      if (error instanceof NotFoundException) {
        this.addError(balance, {
          fila: 0,
          campo: "id_colegio",
          mensaje: "El colegio indicado no existe (llave foránea id_colegio).",
        });
        return;
      }
      throw error;
    }

    let created: StudentRecord[] = [];
    try {
      created = await this.repository.transaction((tx) =>
        this.processRows(buffer, kind, idColegio, tx, balance),
      );
    } catch (error) {
      if (error instanceof RollbackSignal) {
        return; // ROLLBACK ya ejecutado; el balance tiene el detalle
      }
      if (error instanceof EnrollmentFileFormatError) {
        this.addError(balance, { fila: 0, mensaje: error.message });
        return;
      }
      if (error instanceof DuplicateStudentError) {
        this.addError(balance, {
          fila: 0,
          campo:
            error.field === "documento"
              ? "documento_identidad"
              : "codigo_institucional",
          mensaje:
            "Otra carga registró el mismo estudiante mientras se importaba este archivo. No se guardó ninguna fila.",
        });
        return;
      }
      if (error instanceof ForeignKeyViolationError) {
        this.addError(balance, {
          fila: 0,
          mensaje: `Violación de llave foránea (${error.constraint}). No se guardó ninguna fila.`,
        });
        return;
      }
      throw error;
    }

    balance.estado = "COMPLETADA";
    balance.creadas = created.length;
  }

  /** Corre DENTRO de la transacción: lanzar = ROLLBACK. */
  private async processRows(
    buffer: Buffer,
    kind: EnrollmentFileKind,
    idColegio: string,
    tx: StudentWriteTransaction,
    balance: ImportBalance,
  ): Promise<StudentRecord[]> {
    const seenDocuments = new Map<string, number>();
    const seenCodes = new Map<string, number>();
    const inserted: StudentRecord[] = [];
    let columns: (string | null)[] | null = null;
    let batch: RawRow[] = [];

    const flush = async () => {
      if (batch.length === 0) {
        return;
      }
      const records = await this.processBatch(
        batch,
        columns!,
        idColegio,
        tx,
        balance,
        seenDocuments,
        seenCodes,
      );
      // Si ya hay errores no se inserta más: el ROLLBACK es seguro, pero se
      // sigue validando para reportar todas las observaciones de una vez.
      if (balance.total_errores === 0) {
        await tx.insertMany(records);
        inserted.push(...records);
      }
      batch = [];
    };

    for await (const row of readEnrollmentRows(buffer, kind)) {
      if (columns === null) {
        columns = this.mapHeader(row, balance);
        if (balance.total_errores > 0) {
          throw new RollbackSignal();
        }
        continue;
      }
      if (row.cells.every((c) => c === "")) {
        continue;
      }

      balance.total_filas++;
      if (balance.total_filas > IMPORT_MAX_ROWS) {
        this.addError(balance, {
          fila: row.fila,
          mensaje: `El archivo supera el máximo de ${IMPORT_MAX_ROWS} filas por importación.`,
        });
        balance.total_filas--;
        throw new RollbackSignal();
      }

      batch.push(row);
      if (batch.length === IMPORT_BATCH_SIZE) {
        await flush();
      }
    }
    if (columns === null) {
      this.addError(balance, {
        fila: 0,
        mensaje: "El archivo está vacío: falta la fila de encabezados.",
      });
      throw new RollbackSignal();
    }
    await flush();

    if (balance.total_filas === 0) {
      this.addError(balance, {
        fila: 0,
        mensaje: "El archivo no contiene filas de estudiantes.",
      });
    }
    if (balance.total_errores > 0) {
      throw new RollbackSignal();
    }
    return inserted;
  }

  private async processBatch(
    rows: RawRow[],
    columns: (string | null)[],
    idColegio: string,
    tx: StudentWriteTransaction,
    balance: ImportBalance,
    seenDocuments: Map<string, number>,
    seenCodes: Map<string, number>,
  ): Promise<StudentRecord[]> {
    const candidates: { fila: number; record: StudentRecord }[] = [];

    for (const row of rows) {
      balance.filas_procesadas++;
      const plain: Record<string, string> = {};
      columns.forEach((column, i) => {
        if (column && row.cells[i] !== undefined && row.cells[i] !== "") {
          plain[column] = row.cells[i];
        }
      });

      const dto = plainToInstance(ImportStudentRowDto, plain);
      const errors = await validate(dto, { whitelist: true });
      if (errors.length > 0) {
        for (const error of errors) {
          this.addError(balance, {
            fila: row.fila,
            campo: error.property,
            mensaje:
              Object.values(error.constraints ?? {})[0] ?? "Valor inválido.",
          });
        }
        continue;
      }

      const record = Student.create(
        { ...dto, id_colegio: idColegio },
        this.vault,
      );

      const dupDoc = seenDocuments.get(record.documento_blind_index);
      const dupCode = seenCodes.get(record.codigo_institucional);
      if (dupDoc !== undefined) {
        this.addError(balance, {
          fila: row.fila,
          campo: "documento_identidad",
          mensaje: `Documento repetido: ya aparece en la fila ${dupDoc}.`,
        });
      }
      if (dupCode !== undefined) {
        this.addError(balance, {
          fila: row.fila,
          campo: "codigo_institucional",
          mensaje: `Código institucional repetido: ya aparece en la fila ${dupCode}.`,
        });
      }
      if (dupDoc !== undefined || dupCode !== undefined) {
        continue;
      }
      seenDocuments.set(record.documento_blind_index, row.fila);
      seenCodes.set(record.codigo_institucional, row.fila);
      candidates.push({ fila: row.fila, record });
    }

    // Duplicados contra la base de datos (por lote, sobre el índice ciego)
    const [existingDocs, existingCodes] = await Promise.all([
      tx.findExistingBlindIndexes(
        candidates.map((c) => c.record.documento_blind_index),
      ),
      tx.findExistingCodigos(
        candidates.map((c) => c.record.codigo_institucional),
      ),
    ]);

    const valid: StudentRecord[] = [];
    for (const { fila, record } of candidates) {
      let ok = true;
      if (existingDocs.has(record.documento_blind_index)) {
        this.addError(balance, {
          fila,
          campo: "documento_identidad",
          mensaje: "Ya existe un estudiante registrado con ese documento.",
        });
        ok = false;
      }
      if (existingCodes.has(record.codigo_institucional)) {
        this.addError(balance, {
          fila,
          campo: "codigo_institucional",
          mensaje: "Ya existe un estudiante con ese código institucional.",
        });
        ok = false;
      }
      if (ok) {
        valid.push(record);
      }
    }

    balance.filas_validas += valid.length;
    return valid;
  }

  /** Traduce el encabezado a columnas conocidas (null = columna ignorada). */
  private mapHeader(row: RawRow, balance: ImportBalance): (string | null)[] {
    const seen = new Set<string>();
    const columns = row.cells.map((raw, i) => {
      const normalized = normalizeHeader(raw);
      const column = COLUMN_ALIASES[normalized] ?? normalized;
      if (!column) {
        return null;
      }
      if (!KNOWN_COLUMNS.has(column)) {
        balance.advertencias.push({
          fila: row.fila,
          campo: `columna ${i + 1}`,
          mensaje: "Columna no reconocida: se ignoró.",
        });
        return null;
      }
      if (seen.has(column)) {
        this.addError(balance, {
          fila: row.fila,
          campo: column,
          mensaje: "La columna está repetida en el encabezado.",
        });
        return null;
      }
      seen.add(column);
      return column;
    });

    for (const required of REQUIRED_COLUMNS) {
      if (!seen.has(required)) {
        this.addError(balance, {
          fila: row.fila,
          campo: required,
          mensaje: "Falta la columna obligatoria en el encabezado.",
        });
      }
    }
    return columns;
  }

  private detectKind(file: UploadedEnrollmentFile): EnrollmentFileKind {
    const name = file.originalname.toLowerCase();
    const kind: EnrollmentFileKind | null = name.endsWith(".csv")
      ? "CSV"
      : name.endsWith(".xlsx")
        ? "XLSX"
        : null;
    const mime = (file.mimetype ?? "").split(";")[0].trim().toLowerCase();

    if (!kind || !MIME_BY_KIND[kind].includes(mime)) {
      throw new UnsupportedMediaTypeException(
        "Tipo de archivo no permitido. Use CSV (.csv) o Excel (.xlsx).",
      );
    }

    // Verificación del contenido real, no solo del nombre/MIME declarados
    if (kind === "XLSX") {
      const zipMagic = file.buffer.subarray(0, 4).toString("hex");
      if (zipMagic !== "504b0304") {
        throw new UnsupportedMediaTypeException(
          "El archivo no es un Excel .xlsx válido.",
        );
      }
    } else {
      if (file.buffer.includes(0)) {
        throw new UnsupportedMediaTypeException(
          "El archivo no es un CSV de texto válido.",
        );
      }
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(file.buffer);
      } catch {
        throw new UnsupportedMediaTypeException(
          "El CSV debe estar codificado en UTF-8.",
        );
      }
    }
    return kind;
  }

  private addError(balance: ImportBalance, issue: RowIssue): void {
    balance.total_errores++;
    if (balance.errores.length < IMPORT_MAX_ISSUES) {
      balance.errores.push(issue);
    }
  }
}

/** "Código Institucional " -> "codigo_institucional" */
export function normalizeHeader(header: string): string {
  return header
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
