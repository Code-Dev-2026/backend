import { parse } from "csv-parse";
import * as ExcelJS from "exceljs";
import { Readable } from "stream";

export type EnrollmentFileKind = "CSV" | "XLSX";

/** Una fila leída del archivo, con su número de línea/fila original. */
export interface RawRow {
  fila: number;
  cells: string[];
}

/** Error de formato del archivo (no de una fila concreta). */
export class EnrollmentFileFormatError extends Error {}

const MAX_CELL_LENGTH = 2_000;

/**
 * Lee el archivo como STREAM y entrega las filas una a una (la primera es el
 * encabezado). No carga el archivo parseado completo en memoria: el
 * consumidor decide cuándo agrupar en lotes y puede detenerse antes.
 */
export function readEnrollmentRows(
  buffer: Buffer,
  kind: EnrollmentFileKind,
): AsyncGenerator<RawRow> {
  return kind === "CSV" ? readCsv(buffer) : readXlsx(buffer);
}

async function* readCsv(buffer: Buffer): AsyncGenerator<RawRow> {
  const parser = Readable.from([buffer]).pipe(
    parse({
      bom: true,
      // Excel en español exporta CSV con ';'
      delimiter: [",", ";"],
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
      info: true,
      max_record_size: 64 * 1024,
    }),
  );

  try {
    for await (const { record, info } of parser as AsyncIterable<{
      record: string[];
      info: { lines: number };
    }>) {
      yield { fila: info.lines, cells: record.map(clip) };
    }
  } catch (error) {
    throw new EnrollmentFileFormatError(
      `CSV mal formado: ${(error as Error).message}`,
    );
  }
}

async function* readXlsx(buffer: Buffer): AsyncGenerator<RawRow> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(
    Readable.from([buffer]),
    {
      sharedStrings: "cache",
      hyperlinks: "ignore",
      styles: "ignore",
      worksheets: "emit",
      entries: "emit",
    },
  );

  try {
    // Solo la primera hoja del libro
    for await (const worksheet of reader) {
      for await (const row of worksheet) {
        const values = (row.values as unknown[]).slice(1); // índice 0 vacío
        yield { fila: row.number, cells: values.map(cellToString) };
      }
      break;
    }
  } catch (error) {
    if (error instanceof EnrollmentFileFormatError) {
      throw error;
    }
    throw new EnrollmentFileFormatError(
      `Excel mal formado: ${(error as Error).message}`,
    );
  }
}

/** Convierte cualquier tipo de celda de Excel a texto plano. */
export function cellToString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? value.toFixed(0) : String(value);
  }
  if (typeof value === "object") {
    const v = value as {
      richText?: { text: string }[];
      result?: unknown;
      text?: string;
      error?: string;
    };
    if (Array.isArray(v.richText)) {
      return clip(v.richText.map((t) => t.text).join(""));
    }
    if ("result" in v) {
      return cellToString(v.result);
    }
    if (typeof v.text === "string") {
      return clip(v.text);
    }
    if (v.error) {
      return "";
    }
  }
  return clip(String(value).trim());
}

function clip(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_CELL_LENGTH
    ? trimmed.slice(0, MAX_CELL_LENGTH + 1)
    : trimmed;
}
