import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AesEncryptionService } from "@common/crypto/aes-encryption.service";
import { BlindIndexService } from "@common/crypto/blind-index.service";
import { CryptoVaultService } from "@common/crypto/crypto-vault.service";
import { AuthenticatedUser } from "@common/decorators/current-user.decorator";
import { AuditService } from "../audit/audit.service";
import { InMemoryStudentRepository } from "./infrastructure/in-memory-student.repository";
import { StudentsService } from "./students.service";

const AES_FORMAT = /^v[0-9]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

describe("StudentsService (expedientes cifrados)", () => {
  const datos = {
    id_colegio: "018e38d9-3f00-7200-a000-0000000000c1",
    codigo_institucional: "EST-2026-089",
    nombre_completo: "Mateo Gómez Restrepo",
    documento_identidad: "1.088.123.456",
    direccion: "Calle 10 # 5-20, Pereira",
    condiciones_medicas: "Asma leve",
    grado: "4A",
  };
  const coordinadora: AuthenticatedUser = {
    id_usuario: "018e38d9-3f00-7200-a000-000000000001",
    email: "c@colegio.co",
    roles: ["COORDINADORA_CONVIVENCIA"],
    mfa_autenticado: true,
  };

  let repository: InMemoryStudentRepository;
  let vault: CryptoVaultService;
  let audit: { logCriticalEvent: jest.Mock };
  let service: StudentsService;

  beforeEach(() => {
    const config = {
      get: jest.fn((_k: string, def?: string) => def),
    } as unknown as ConfigService;
    vault = new CryptoVaultService(
      new AesEncryptionService(config),
      new BlindIndexService(config),
      config,
    );
    repository = new InMemoryStudentRepository();
    audit = { logCriticalEvent: jest.fn().mockResolvedValue(undefined) };
    service = new StudentsService(
      repository,
      vault,
      audit as unknown as AuditService,
    );
  });

  describe("persistencia", () => {
    it("guarda los datos de identificación y médicos solo cifrados AES-256-GCM", async () => {
      await service.create(datos, coordinadora);
      const [stored] = repository.dump();

      for (const field of [
        "nombre_completo_enc",
        "documento_identidad_enc",
        "direccion_enc",
        "condiciones_medicas_enc",
      ] as const) {
        expect(stored[field]).toMatch(AES_FORMAT);
      }

      const crudo = JSON.stringify(stored);
      for (const claro of [
        "Mateo",
        "Gómez",
        "1088123456",
        "1.088.123.456",
        "Calle 10",
        "Asma",
      ]) {
        expect(crudo).not.toContain(claro);
      }
      expect(stored.documento_blind_index).toMatch(/^[0-9a-f]{64}$/);
    });

    it("sin condiciones médicas guarda null, no un texto vacío", async () => {
      await service.create(
        { ...datos, condiciones_medicas: undefined },
        coordinadora,
      );
      expect(repository.dump()[0].condiciones_medicas_enc).toBeNull();
    });

    it("rechaza un documento duplicado aunque venga con otro formato", async () => {
      await service.create(datos, coordinadora);

      await expect(
        service.create(
          {
            ...datos,
            codigo_institucional: "EST-2026-090",
            documento_identidad: "1088 123 456",
          },
          coordinadora,
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("búsqueda por documento (blind index)", () => {
    it.each(["1088123456", "1.088.123.456", " 1088-123-456 "])(
      "encuentra el expediente buscando '%s'",
      async (documento) => {
        const created = await service.create(datos, coordinadora);

        const found = await service.findByDocument(documento, coordinadora);

        expect(found.id_estudiante).toBe(created.id_estudiante);
        expect(found.documento_identidad).toBe("1088123456");
      },
    );

    it("busca por el índice ciego, sin descifrar los registros", async () => {
      await service.create(datos, coordinadora);
      const findByBlindIndex = jest.spyOn(repository, "findByBlindIndex");
      const decrypt = jest.spyOn(vault, "decrypt");

      await expect(
        service.findByDocument("9999999999", coordinadora),
      ).rejects.toThrow(NotFoundException);

      expect(findByBlindIndex).toHaveBeenCalledWith(
        vault.generateBlindIndex("9999999999"),
      );
      expect(decrypt).not.toHaveBeenCalled();
    });
  });

  describe("descifrado y permisos", () => {
    it("descifra el expediente completo en memoria para un rol administrativo", async () => {
      const created = await service.create(datos, coordinadora);

      const expediente = await service.getExpediente(
        created.id_estudiante,
        coordinadora,
      );

      expect(expediente).toMatchObject({
        nombre_completo: "Mateo Gómez Restrepo",
        documento_identidad: "1088123456",
        direccion: "Calle 10 # 5-20, Pereira",
        condiciones_medicas: "Asma leve",
        grado: "4A",
      });
      expect(expediente).not.toHaveProperty("documento_blind_index");
      expect(expediente).not.toHaveProperty("documento_identidad_enc");
    });

    it("rectoría también puede consultar", async () => {
      const created = await service.create(datos, coordinadora);

      await expect(
        service.getExpediente(created.id_estudiante, {
          ...coordinadora,
          roles: ["RECTORIA"],
        }),
      ).resolves.toBeDefined();
    });

    it.each([
      ["sin usuario", undefined],
      ["acudiente", { ...coordinadora, roles: ["ACUDIENTE"] }],
      ["monitora", { ...coordinadora, roles: ["MONITORA"] }],
      ["conductor", { ...coordinadora, roles: ["CONDUCTOR"] }],
      ["admin sin MFA", { ...coordinadora, mfa_autenticado: false }],
    ])("no descifra nada para %s", async (_n, actor) => {
      const created = await service.create(datos, coordinadora);
      const decrypt = jest.spyOn(vault, "decrypt");

      await expect(
        service.getExpediente(created.id_estudiante, actor),
      ).rejects.toThrow(ForbiddenException);
      await expect(service.findByDocument("1088123456", actor)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.list(0, 10, actor)).rejects.toThrow(
        ForbiddenException,
      );
      expect(decrypt).not.toHaveBeenCalled();
    });

    it("el listado no expone documento, dirección ni datos médicos", async () => {
      await service.create(datos, coordinadora);

      const page = await service.list(0, 10, coordinadora);

      expect(page.total).toBe(1);
      expect(page.items[0]).toEqual({
        id_estudiante: expect.any(String),
        codigo_institucional: "EST-2026-089",
        nombre_completo: "Mateo Gómez Restrepo",
        grado: "4A",
        activo: true,
      });
    });

    it("NotFound si el expediente no existe", async () => {
      await expect(
        service.getExpediente(
          "018e38d9-3f00-7200-a000-0000000000ff",
          coordinadora,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("auditoría", () => {
    it("registra cada acceso sin datos personales en la bitácora", async () => {
      const created = await service.create(datos, coordinadora);
      await service.getExpediente(created.id_estudiante, coordinadora);
      await service.findByDocument("1088123456", coordinadora);

      const eventos = audit.logCriticalEvent.mock.calls.map((c) => c[0]);
      expect(eventos.map((e) => e.tipo_evento)).toEqual([
        "EXPEDIENTE_CREADO",
        "EXPEDIENTE_CONSULTADO",
        "EXPEDIENTE_BUSQUEDA_DOCUMENTO",
      ]);
      expect(eventos[1]).toMatchObject({
        id_usuario: coordinadora.id_usuario,
        id_estudiante: created.id_estudiante,
      });
      const serializado = JSON.stringify(eventos);
      expect(serializado).not.toContain("1088123456");
      expect(serializado).not.toContain("Mateo");
    });
  });
});
