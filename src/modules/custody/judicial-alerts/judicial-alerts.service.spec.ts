import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AesEncryptionService } from "@common/crypto/aes-encryption.service";
import { BlindIndexService } from "@common/crypto/blind-index.service";
import { CryptoVaultService } from "@common/crypto/crypto-vault.service";
import { HashService } from "@common/crypto/hash.service";
import { AuditService } from "../../audit/audit.service";
import { IJudicialAlertRepository } from "./domain/judicial-alert-repository.port";
import {
  JUDICIAL_BLOCKING_CODE,
  JudicialProtectionEngineError,
} from "./domain/judicial-alert.types";
import { InMemoryJudicialAlertRepository } from "./infrastructure/in-memory-judicial-alert.repository";
import { JudicialAlertsService } from "./judicial-alerts.service";

const makeUuid = (suffix: number) =>
  `018e38d9-3f00-7200-a300-${String(suffix).padStart(12, "0")}`;

describe("JudicialAlertsService (Issue #10: Gestión segura AES-256-GCM y blind index HMAC)", () => {
  let repository: InMemoryJudicialAlertRepository;
  let cryptoVault: CryptoVaultService;
  let blindIndexService: BlindIndexService;
  let hashService: HashService;
  let auditService: AuditService;
  let service: JudicialAlertsService;

  const studentA = makeUuid(101);
  const studentB = makeUuid(102);
  const rectoriaUserId = makeUuid(201);
  const coordinatorId = makeUuid(301);

  beforeEach(() => {
    const config = new ConfigService({
      NODE_ENV: "test",
      APP_BLIND_INDEX_HMAC_KEY: Buffer.from(
        "test-hmac-key-32-bytes-issue-10!",
      ).toString("base64"),
      APP_ENCRYPTION_MASTER_KEY: Buffer.from(
        "test-aes-key-32-bytes-issue-010!",
      ).toString("base64"),
    });
    blindIndexService = new BlindIndexService(config);
    cryptoVault = new CryptoVaultService(
      new AesEncryptionService(config),
      blindIndexService,
      config,
    );
    hashService = new HashService();
    auditService = new AuditService();
    repository = new InMemoryJudicialAlertRepository();
    service = new JudicialAlertsService(
      repository,
      cryptoVault,
      hashService,
      blindIndexService,
      auditService,
    );
  });

  it("cifra datos de la orden judicial con AES-256-GCM, genera documento_restringido_hash HMAC y evita falsos positivos por homonimia", async () => {
    const created = await service.createAlert(
      {
        id_estudiante: studentA,
        juzgado_emisor: "Comisaría Primera de Familia de Pereira",
        radicado_medida: "CFP-2026-00145",
        individuo_restringido_nombre: "Juan Carlos Pérez",
        individuo_restringido_documento: "79.123.456",
        orden_judicial_resumen:
          "Prohibición categórica de acercamiento y retiro del menor.",
        foto_individuo_referencia: "vault://judicial/cfp-145.jpg",
      },
      rectoriaUserId,
    );

    expect(created.activa).toBe(true);
    expect(created.eliminado_soft).toBe(false);
    expect(created.documento_restringido_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(created.hash_integridad_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(created.individuo_restringido_documento_enmascarado).toBe(
      "****3456",
    );

    // Verificar en almacenamiento que ningún campo sensible quede en texto plano
    const stored = await repository.findById(created.id_alerta);
    expect(stored).not.toBeNull();
    expect(stored!.individuo_restringido_nombre_cifrado).not.toContain(
      "Juan Carlos",
    );
    expect(stored!.individuo_restringido_documento_cifrado).not.toContain(
      "79123456",
    );
    expect(stored!.orden_judicial_resumen_cifrado).not.toContain("Prohibición");
    expect(stored!.individuo_restringido_documento_cifrado).toMatch(
      /^v1:[^:]+:[^:]+:[^:]+$/,
    );

    // Cruce determinista exacto con distintas grafías de cédula 79123456
    const verifyPlain = await service.verifyRestriction({
      id_estudiante: studentA,
      documento_receptor: "79123456",
    });
    expect(verifyPlain.bloqueada).toBe(true);
    expect(verifyPlain.codigo).toBe(JUDICIAL_BLOCKING_CODE);
    expect(verifyPlain.radicado_medida).toBe("CFP-2026-00145");

    const verifySpaced = await service.verifyRestriction({
      id_estudiante: studentA,
      documento_receptor: "79 123 456",
    });
    expect(verifySpaced.bloqueada).toBe(true);
    expect(verifySpaced.documento_restringido_hash).toBe(
      verifyPlain.documento_restringido_hash,
    );

    // Mitigación de riesgo de homonimia: otro individuo con cédula distinta no genera falso positivo
    const verifyHomonym = await service.verifyRestriction({
      id_estudiante: studentA,
      documento_receptor: "79123457",
    });
    expect(verifyHomonym.bloqueada).toBe(false);
    expect(verifyHomonym.codigo).toBe("SIN_RESTRICCION_JUDICIAL");

    // Aislamiento por estudiante: alerta de studentA no bloquea a studentB
    const verifyOtherStudent = await service.verifyRestriction({
      id_estudiante: studentB,
      documento_receptor: "79123456",
    });
    expect(verifyOtherStudent.bloqueada).toBe(false);
  });

  it("permite soft-delete auditable y rechaza radicados duplicados, documentos inválidos o hashes contradictorios", async () => {
    const created = await service.createAlert(
      {
        id_estudiante: studentA,
        juzgado_emisor: "Juzgado 2 de Familia",
        radicado_medida: "JF2-2026-800",
        individuo_restringido_nombre: "Pedro Restringido",
        individuo_restringido_documento: "79123456",
        orden_judicial_resumen: "Medida cautelar preventiva.",
      },
      rectoriaUserId,
    );

    // Radicado duplicado -> 409 Conflict
    await expect(
      service.createAlert(
        {
          id_estudiante: studentA,
          juzgado_emisor: "Juzgado 2 de Familia",
          radicado_medida: "JF2-2026-800",
          individuo_restringido_nombre: "Otro",
          individuo_restringido_documento: "10002000",
          orden_judicial_resumen: "Duplicado",
        },
        rectoriaUserId,
      ),
    ).rejects.toThrow(ConflictException);

    // Documento contradictorio con hash -> 400 BadRequest
    await expect(
      service.verifyRestriction({
        id_estudiante: studentA,
        documento_receptor: "79123456",
        documento_restringido_hash: "a".repeat(64),
      }),
    ).rejects.toThrow(BadRequestException);

    // Sin documento ni hash -> 400 BadRequest
    await expect(
      service.verifyRestriction({
        id_estudiante: studentA,
      }),
    ).rejects.toThrow(BadRequestException);

    // Soft-delete auditable levanta el bloqueo pero conserva registro histórico
    const deactivated = await service.deactivateAlert(
      created.id_alerta,
      {
        eliminado_por_coordinacion: coordinatorId,
        autorizado_excepcion_por: "Auto 089 Juzgado 2 de Familia",
      },
      rectoriaUserId,
    );
    expect(deactivated.activa).toBe(false);
    expect(deactivated.eliminado_soft).toBe(true);
    expect(deactivated.eliminado_por_coordinacion).toBe(coordinatorId);

    // Doble desactivación -> 409 Conflict
    await expect(
      service.deactivateAlert(created.id_alerta, {}, rectoriaUserId),
    ).rejects.toThrow(ConflictException);

    // Alerta inexistente -> 404 NotFound
    await expect(
      service.deactivateAlert(makeUuid(9999), {}, rectoriaUserId),
    ).rejects.toThrow(NotFoundException);

    // Tras levantamiento, la verificación ya no bloquea
    const verifyAfterLift = await service.verifyRestriction({
      id_estudiante: studentA,
      documento_receptor: "79123456",
    });
    expect(verifyAfterLift.bloqueada).toBe(false);

    // Listado por defecto oculta inactivas; con incluir_inactivas=true conserva evidencia histórica
    expect(await service.listStudentAlerts(studentA, false)).toHaveLength(0);
    expect(await service.listStudentAlerts(studentA, true)).toHaveLength(1);
  });

  it("falla de forma segura (JudicialProtectionEngineError) si el repositorio presenta un error técnico", async () => {
    const brokenRepo: IJudicialAlertRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      listByStudent: jest.fn(),
      deactivateSoft: jest.fn(),
      findActiveMatchByBlindIndex: jest
        .fn()
        .mockRejectedValue(new Error("ECONNREFUSED postgresql")),
    };

    const failSafeService = new JudicialAlertsService(
      brokenRepo,
      cryptoVault,
      hashService,
      blindIndexService,
      auditService,
    );

    const hash = failSafeService.computeRestrictedDocumentHash("79123456");
    await expect(
      failSafeService.findActiveRestrictionByHash(studentA, hash),
    ).rejects.toThrow(JudicialProtectionEngineError);
  });
});
