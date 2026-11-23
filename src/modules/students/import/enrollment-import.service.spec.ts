import {
  ConflictException,
  ForbiddenException,
  HttpStatus,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as ExcelJS from "exceljs";
import { AesEncryptionService } from "@common/crypto/aes-encryption.service";
import { BlindIndexService } from "@common/crypto/blind-index.service";
import { CryptoVaultService } from "@common/crypto/crypto-vault.service";
import { HashService } from "@common/crypto/hash.service";
import { AuthenticatedUser } from "@common/decorators/current-user.decorator";
import { AuditService } from "../../audit/audit.service";
import { SchoolsService } from "../../schools/schools.service";
import { ForeignKeyViolationError } from "../domain/student.repository";
import { InMemoryStudentRepository } from "../infrastructure/in-memory-student.repository";
import {
  EnrollmentImportService,
  IMPORT_MAX_ROWS,
  UploadedEnrollmentFile,
} from "./enrollment-import.service";
import { InMemoryImportLedger } from "./import-ledger";

const COLEGIO = "018e38d9-3f00-7200-a000-000000000002";
const AES_FORMAT = /^v[0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;
const HEADER =
  "codigo_institucional,nombre_completo,documento_identidad,direccion,condiciones_medicas,grado";

function fila(i: number, overrides: Partial<Record<string, string>> = {}) {
  const r = {
    codigo: `EST-${String(i).padStart(4, "0")}`,
    nombre: `Estudiante Prueba ${i}`,
    documento: String(1_000_000_000 + i),
    direccion: `Calle ${i} # 1-2`,
    medicas: i % 2 === 0 ? "Asma leve" : "",
    grado: "4A",
    ...overrides,
  };
  return [
    r.codigo,
    r.nombre,
    r.documento,
    r.direccion,
    r.medicas,
    r.grado,
  ].join(",");
}

function csvFile(
  lines: string[],
  name = "matriculas.csv",
  mimetype = "text/csv",
): UploadedEnrollmentFile {
  const buffer = Buffer.from(lines.join("\n"), "utf8");
  return { originalname: name, mimetype, size: buffer.length, buffer };
}

function csvDe(n: number, extra: string[] = []) {
  return csvFile([
    HEADER,
    ...Array.from({ length: n }, (_, i) => fila(i + 1)),
    ...extra,
  ]);
}

describe("EnrollmentImportService", () => {
  const admin: AuthenticatedUser = {
    id_usuario: "018e38d9-3f00-7200-a000-000000000001",
    email: "c@colegio.co",
    roles: ["COORDINADORA_CONVIVENCIA"],
    mfa_autenticado: true,
  };

  let repository: InMemoryStudentRepository;
  let ledger: InMemoryImportLedger;
  let audit: { logCriticalEvent: jest.Mock };
  let service: EnrollmentImportService;

  beforeEach(() => {
    const config = {
      get: jest.fn((_k: string, def?: string) => def),
    } as unknown as ConfigService;
    const vault = new CryptoVaultService(
      new AesEncryptionService(config),
      new BlindIndexService(config),
      config,
    );
    repository = new InMemoryStudentRepository();
    ledger = new InMemoryImportLedger();
    audit = { logCriticalEvent: jest.fn().mockResolvedValue(undefined) };
    service = new EnrollmentImportService(
      repository,
      ledger,
      vault,
      new HashService(),
      new SchoolsService(),
      audit as unknown as AuditService,
    );
  });

  describe("importación correcta", () => {
    it("crea todos los estudiantes y devuelve el balance (201)", async () => {
      const file = csvDe(3);

      const { httpStatus, balance } = await service.import(
        file,
        COLEGIO,
        admin,
      );

      expect(httpStatus).toBe(HttpStatus.CREATED);
      expect(balance).toMatchObject({
        estado: "COMPLETADA",
        total_filas: 3,
        filas_procesadas: 3,
        filas_validas: 3,
        creadas: 3,
        total_errores: 0,
        errores: [],
      });
      expect(balance.archivo.hash_sha256).toBe(
        new HashService().sha256Buffer(file.buffer),
      );
      expect(repository.dump()).toHaveLength(3);
    });

    it("persiste los datos solo cifrados", async () => {
      await service.import(csvDe(2), COLEGIO, admin);

      for (const record of repository.dump()) {
        expect(record.nombre_completo_enc).toMatch(AES_FORMAT);
        expect(record.documento_identidad_enc).toMatch(AES_FORMAT);
        expect(record.id_colegio).toBe(COLEGIO);
      }
      expect(JSON.stringify(repository.dump())).not.toContain("1000000001");
    });

    it("procesa por lotes de 100 dentro de una sola transacción", async () => {
      const original = repository.transaction.bind(repository);
      const transaction = jest.spyOn(repository, "transaction");
      const inserts: number[] = [];
      transaction.mockImplementation((work) =>
        original((tx) => {
          const insertMany = tx.insertMany.bind(tx);
          tx.insertMany = async (records) => {
            inserts.push(records.length);
            return insertMany(records);
          };
          return work(tx);
        }),
      );

      const { balance } = await service.import(csvDe(250), COLEGIO, admin);

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(inserts).toEqual([100, 100, 50]);
      expect(balance.creadas).toBe(250);
    });

    it("acepta ';' como separador, BOM y encabezados con tildes/alias", async () => {
      const file = csvFile([
        "﻿Código Institucional;Nombre;Documento;Dirección;Condiciones médicas;Grado",
        "EST-1;Mateo Gómez;1.088.123.456;Calle 10;Asma;4A",
      ]);

      const { balance } = await service.import(file, COLEGIO, admin);

      expect(balance.estado).toBe("COMPLETADA");
      expect(balance.creadas).toBe(1);
    });

    it("ignora filas vacías y advierte columnas desconocidas", async () => {
      const file = csvFile([
        `${HEADER},observacion_interna`,
        `${fila(1)},x`,
        ",,,,,,",
        `${fila(2)},y`,
      ]);

      const { balance } = await service.import(file, COLEGIO, admin);

      expect(balance.creadas).toBe(2);
      expect(balance.total_filas).toBe(2);
      expect(balance.advertencias).toEqual([
        expect.objectContaining({
          fila: 1,
          mensaje: expect.stringContaining("ignoró"),
        }),
      ]);
    });

    it("importa un Excel .xlsx", async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Matrículas");
      ws.addRow(HEADER.split(","));
      ws.addRow(["EST-1", "Mateo Gómez", 1088123456, "Calle 10", "", "4A"]);
      ws.addRow([
        "EST-2",
        { richText: [{ text: "Ana " }, { text: "Ruiz" }] },
        "1088000002",
        "Cra 5",
        "Diabetes",
        "5B",
      ]);
      const buffer = Buffer.from(await wb.xlsx.writeBuffer());

      const { httpStatus, balance } = await service.import(
        {
          originalname: "matriculas.xlsx",
          mimetype:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          size: buffer.length,
          buffer,
        },
        COLEGIO,
        admin,
      );

      expect(httpStatus).toBe(HttpStatus.CREATED);
      expect(balance.archivo.tipo).toBe("XLSX");
      expect(balance.creadas).toBe(2);
    });

    it("registra la importación en la bitácora sin datos personales", async () => {
      await service.import(csvDe(2), COLEGIO, admin);

      const evento = audit.logCriticalEvent.mock.calls[0][0];
      expect(evento.tipo_evento).toBe("IMPORTACION_MATRICULAS_COMPLETADA");
      expect(evento.payload).toMatchObject({ creadas: 2, total_errores: 0 });
      expect(JSON.stringify(evento)).not.toContain("Estudiante Prueba");
    });
  });

  describe("idempotencia por SHA-256", () => {
    it("rechaza con 409 el mismo archivo ya importado", async () => {
      const file = csvDe(2);
      await service.import(file, COLEGIO, admin);

      await expect(service.import(file, COLEGIO, admin)).rejects.toThrow(
        ConflictException,
      );
      expect(repository.dump()).toHaveLength(2);
    });

    it("detecta el duplicado aunque cambie el nombre del archivo", async () => {
      const file = csvDe(2);
      await service.import(file, COLEGIO, admin);

      await expect(
        service.import({ ...file, originalname: "copia.csv" }, COLEGIO, admin),
      ).rejects.toThrow(ConflictException);
    });

    it("dos cargas simultáneas del mismo archivo: solo una se procesa", async () => {
      const file = csvDe(5);

      const results = await Promise.allSettled([
        service.import(file, COLEGIO, admin),
        service.import(file, COLEGIO, admin),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect(repository.dump()).toHaveLength(5);
    });

    it("un archivo revertido no queda bloqueado (se puede reintentar)", async () => {
      const file = csvDe(2, [fila(3, { documento: "abc" })]);

      const first = await service.import(file, COLEGIO, admin);
      const second = await service.import(file, COLEGIO, admin);

      expect(first.httpStatus).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(second.httpStatus).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      await expect(
        ledger.findByHash(first.balance.archivo.hash_sha256),
      ).resolves.toBeNull();
    });
  });

  describe("validación y rollback integral", () => {
    it("con una fila inválida no guarda NINGUNA (422) y detalla la fila", async () => {
      const file = csvDe(3, [
        fila(4, { documento: "x" }),
        fila(5, { nombre: "" }),
      ]);

      const { httpStatus, balance } = await service.import(
        file,
        COLEGIO,
        admin,
      );

      expect(httpStatus).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(balance).toMatchObject({
        estado: "REVERTIDA",
        total_filas: 5,
        filas_procesadas: 5,
        filas_validas: 3,
        creadas: 0,
        total_errores: 2,
      });
      expect(balance.errores).toEqual([
        { fila: 5, campo: "documento_identidad", mensaje: expect.any(String) },
        { fila: 6, campo: "nombre_completo", mensaje: expect.any(String) },
      ]);
      expect(repository.dump()).toHaveLength(0);
    });

    it("revierte también los lotes ya insertados si falla una fila posterior", async () => {
      const file = csvDe(250, [fila(251, { grado: "" })]);

      const { balance } = await service.import(file, COLEGIO, admin);

      expect(balance.estado).toBe("REVERTIDA");
      expect(balance.errores[0].fila).toBe(252);
      expect(repository.dump()).toHaveLength(0);
    });

    it("ante una violación de llave foránea en la inserción hace rollback", async () => {
      const original = repository.transaction.bind(repository);
      jest.spyOn(repository, "transaction").mockImplementation((work) =>
        original((tx) => {
          let calls = 0;
          const insertMany = tx.insertMany.bind(tx);
          tx.insertMany = async (records) => {
            if (++calls === 2) {
              throw new ForeignKeyViolationError("estudiante_id_colegio_fkey");
            }
            return insertMany(records);
          };
          return work(tx);
        }),
      );

      const { httpStatus, balance } = await service.import(
        csvDe(150),
        COLEGIO,
        admin,
      );

      expect(httpStatus).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(balance.errores[0].mensaje).toContain("llave foránea");
      expect(repository.dump()).toHaveLength(0); // el primer lote también se revirtió
    });

    it("rechaza un colegio inexistente (FK id_colegio)", async () => {
      const { balance } = await service.import(
        csvDe(2),
        "018e38d9-3f00-7200-a000-0000000000ff",
        admin,
      );

      expect(balance.estado).toBe("REVERTIDA");
      expect(balance.errores[0]).toMatchObject({
        fila: 0,
        campo: "id_colegio",
      });
      expect(repository.dump()).toHaveLength(0);
    });

    it("detecta documentos y códigos repetidos dentro del archivo", async () => {
      const file = csvDe(2, [
        fila(3, { documento: "1.000.000.001" }), // = fila 1 normalizada
        fila(4, { codigo: "EST-0002" }),
      ]);

      const { balance } = await service.import(file, COLEGIO, admin);

      expect(balance.errores).toEqual([
        expect.objectContaining({
          fila: 4,
          campo: "documento_identidad",
          mensaje: expect.stringContaining("fila 2"),
        }),
        expect.objectContaining({
          fila: 5,
          campo: "codigo_institucional",
          mensaje: expect.stringContaining("fila 3"),
        }),
      ]);
      expect(repository.dump()).toHaveLength(0);
    });

    it("detecta estudiantes que ya existen en la base de datos", async () => {
      await service.import(csvDe(2), COLEGIO, admin);
      const file = csvFile([HEADER, fila(2), fila(3)]);

      const { balance } = await service.import(file, COLEGIO, admin);

      expect(balance.estado).toBe("REVERTIDA");
      expect(balance.errores.map((e) => e.campo)).toEqual([
        "documento_identidad",
        "codigo_institucional",
      ]);
      expect(repository.dump()).toHaveLength(2); // solo la importación previa
    });

    it("falla si falta una columna obligatoria", async () => {
      const file = csvFile([
        "codigo_institucional,nombre_completo,grado",
        "EST-1,Ana,4A",
      ]);

      const { balance } = await service.import(file, COLEGIO, admin);

      expect(balance.errores.map((e) => e.campo)).toEqual([
        "documento_identidad",
        "direccion",
      ]);
    });

    it("falla con un archivo sin filas de datos", async () => {
      const { balance } = await service.import(
        csvFile([HEADER]),
        COLEGIO,
        admin,
      );

      expect(balance.estado).toBe("REVERTIDA");
      expect(balance.errores[0].mensaje).toContain("no contiene filas");
    });

    it(`rechaza archivos de más de ${IMPORT_MAX_ROWS} filas`, async () => {
      const { balance } = await service.import(
        csvDe(IMPORT_MAX_ROWS + 1),
        COLEGIO,
        admin,
      );

      expect(balance.estado).toBe("REVERTIDA");
      expect(balance.errores[0].mensaje).toContain(String(IMPORT_MAX_ROWS));
      expect(repository.dump()).toHaveLength(0);
    }, 60_000);

    it("las observaciones no repiten datos personales del archivo", async () => {
      const file = csvDe(1, [
        fila(2, { documento: "1088-ABC-!!", nombre: "Lucía Pérez" }),
      ]);

      const { balance } = await service.import(file, COLEGIO, admin);
      const serializado = JSON.stringify(balance.errores);

      expect(serializado).not.toContain("1088-ABC");
      expect(serializado).not.toContain("Lucía");
    });
  });

  describe("tipo de archivo y permisos", () => {
    it.each([
      ["matriculas.pdf", "application/pdf"],
      ["matriculas.xls", "application/vnd.ms-excel"],
      ["matriculas.csv", "application/pdf"],
    ])("rechaza %s (%s) con 415", async (name, mime) => {
      await expect(
        service.import(csvFile([HEADER, fila(1)], name, mime), COLEGIO, admin),
      ).rejects.toThrow(UnsupportedMediaTypeException);
    });

    it("rechaza un .xlsx cuyo contenido no es un Excel real", async () => {
      await expect(
        service.import(
          csvFile(
            [HEADER, fila(1)],
            "matriculas.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          ),
          COLEGIO,
          admin,
        ),
      ).rejects.toThrow(UnsupportedMediaTypeException);
    });

    it("rechaza un CSV que no está en UTF-8", async () => {
      const buffer = Buffer.from(
        `${HEADER}\nEST-1,Mu\xf1oz,1088,Calle,,4A`,
        "latin1",
      );

      await expect(
        service.import(
          {
            originalname: "m.csv",
            mimetype: "text/csv",
            size: buffer.length,
            buffer,
          },
          COLEGIO,
          admin,
        ),
      ).rejects.toThrow(UnsupportedMediaTypeException);
    });

    it.each([
      ["conductor", { ...admin, roles: ["CONDUCTOR"] }],
      ["admin sin MFA", { ...admin, mfa_autenticado: false }],
    ])("deniega a %s (403)", async (_n, actor) => {
      await expect(service.import(csvDe(1), COLEGIO, actor)).rejects.toThrow(
        ForbiddenException,
      );
      expect(repository.dump()).toHaveLength(0);
    });
  });
});
