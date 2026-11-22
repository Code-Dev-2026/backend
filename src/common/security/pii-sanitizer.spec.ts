import { ConsoleLogger } from "@nestjs/common";
import {
  REDACTED,
  sanitize,
  sanitizeString,
  sanitizeUrl,
} from "./pii-sanitizer";
import { SanitizingLogger } from "./sanitizing-logger";

describe("pii-sanitizer", () => {
  it("redacta campos sensibles del estudiante y secretos, en profundidad", () => {
    const input = {
      id_estudiante: "018e38d9-3f00-7200-a000-000000000001",
      grado: "4A",
      nombre_completo: "Mateo Gómez",
      documento_identidad: "1088123456",
      direccion: "Calle 10",
      condiciones_medicas: "Asma",
      documento_blind_index: "a".repeat(64),
      nested: {
        password: "x",
        refreshToken: "y",
        items: [{ email: "a@b.co" }],
      },
    };

    const out = sanitize(input) as Record<string, any>;

    expect(out.id_estudiante).toBe(input.id_estudiante);
    expect(out.grado).toBe("4A");
    for (const k of [
      "nombre_completo",
      "documento_identidad",
      "direccion",
      "condiciones_medicas",
      "documento_blind_index",
    ]) {
      expect(out[k]).toBe(REDACTED);
    }
    expect(out.nested.password).toBe(REDACTED);
    expect(out.nested.refreshToken).toBe(REDACTED);
    expect(out.nested.items[0].email).toBe(REDACTED);
    expect(input.nombre_completo).toBe("Mateo Gómez"); // no muta
  });

  it("enmascara PII dentro de textos libres", () => {
    const text =
      "Documento 1088123456 y 1.088.123.456 de mateo@correo.co " +
      "cifrado v1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBB==:CCCC " +
      "jwt eyJhbGciOi.eyJzdWIiOi.abc123 Bearer abc.def";

    const out = sanitizeString(text);

    expect(out).not.toContain("1088123456");
    expect(out).not.toContain("1.088.123.456");
    expect(out).not.toContain("mateo@correo.co");
    expect(out).not.toContain("AAAAAAAAAAAAAAAA");
    expect(out).not.toContain("eyJhbGciOi");
    expect(out).toContain("[CIFRADO]");
  });

  it("no altera UUIDs, latencias ni códigos HTTP", () => {
    const line =
      "GET /api/v1/students/018e38d9-3f00-7200-a000-000000000001 200 - 12ms";
    expect(sanitizeString(line)).toBe(line);
  });

  it("sanitiza la URL: documento en la ruta y parámetros sensibles", () => {
    expect(sanitizeUrl("/students/by-document/1088123456")).toBe(
      "/students/by-document/[NUMERO]",
    );
    expect(sanitizeUrl("/students?documento=1088&offset=0")).toBe(
      `/students?documento=${REDACTED}&offset=0`,
    );
    expect(sanitizeUrl("/x?token=abc&grado=4A")).toBe(
      `/x?token=${REDACTED}&grado=4A`,
    );
  });
});

describe("SanitizingLogger", () => {
  let written: string[];
  let logger: SanitizingLogger;

  beforeEach(() => {
    written = [];
    logger = new SanitizingLogger();
    jest
      .spyOn(ConsoleLogger.prototype as any, "printMessages")
      .mockImplementation((...args: unknown[]) => {
        written.push(JSON.stringify(args[0]));
      });
  });

  afterEach(() => jest.restoreAllMocks());

  it("sanitiza mensajes de texto y objetos antes de escribirlos", () => {
    logger.log("Alta del documento 1088123456", "Students");
    logger.error({ documento_identidad: "1088123456", grado: "4A" });

    const all = written.join(" ");
    expect(all).not.toContain("1088123456");
    expect(all).toContain("4A");
  });

  it("deja pasar el transporte de correo de desarrollo (OTP de prueba)", () => {
    logger.warn("Tu código es 482913", "MailerService:dev");

    expect(written.join(" ")).toContain("482913");
  });
});
