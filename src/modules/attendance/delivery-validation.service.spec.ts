import { ConfigService } from "@nestjs/config";
import { AesEncryptionService } from "@common/crypto/aes-encryption.service";
import { BlindIndexService } from "@common/crypto/blind-index.service";
import { CryptoVaultService } from "@common/crypto/crypto-vault.service";
import { HashService } from "@common/crypto/hash.service";
import { DeliveryValidationService } from "./delivery-validation.service";
import {
  AuthorizationExpiredError,
  AuthorizedAdultsLimitExceededError,
  CoordinatorUnauthorizedError,
  IncompatibleTripDirectionError,
  JudicialAlertBlockedError,
  ReceptorInactiveOrRevokedError,
  ReceptorType,
  ReceptorUnauthorizedError,
  StudentNotFoundError,
} from "./domain/disembark.types";
import { InMemoryAttendanceRepository } from "./infrastructure/in-memory-attendance.repository";

const makeUuid = (suffix: number) =>
  `018e38d9-3f00-7200-a100-${String(suffix).padStart(12, "0")}`;

describe("DeliveryValidationService (SRP - Validación de receptores Issue #9 / RF-09 / RN-04 / ASVS V4.1)", () => {
  let repository: InMemoryAttendanceRepository;
  let cryptoVault: CryptoVaultService;
  let blindIndexService: BlindIndexService;
  let hashService: HashService;
  let service: DeliveryValidationService;

  const schoolA = makeUuid(10);
  const schoolB = makeUuid(11);
  const studentA = makeUuid(101);
  const studentB = makeUuid(102);
  const guardianA = makeUuid(201);
  const authValid = makeUuid(301);
  const authExpired = makeUuid(302);
  const authRevoked = makeUuid(303);
  const coordinatorA = makeUuid(401);
  const coordinatorB = makeUuid(402);

  beforeEach(() => {
    const config = new ConfigService({
      NODE_ENV: "test",
      APP_BLIND_INDEX_HMAC_KEY: Buffer.from(
        "test-hmac-key-32-bytes-issue-09!",
      ).toString("base64"),
      APP_ENCRYPTION_MASTER_KEY: Buffer.from(
        "test-aes-key-32-bytes-issue-009!",
      ).toString("base64"),
    });
    blindIndexService = new BlindIndexService(config);
    cryptoVault = new CryptoVaultService(
      new AesEncryptionService(config),
      blindIndexService,
      config,
    );
    hashService = new HashService();
    repository = new InMemoryAttendanceRepository();
    service = new DeliveryValidationService(
      repository,
      cryptoVault,
      blindIndexService,
    );

    repository.registerStudent({
      id_estudiante: studentA,
      id_colegio: schoolA,
      activo: true,
      qr_token_hash: hashService.sha256("QR-VAL-A"),
      id_acudiente_titular: guardianA,
    });
    repository.registerStudent({
      id_estudiante: studentB,
      id_colegio: schoolA,
      activo: true,
      qr_token_hash: hashService.sha256("QR-VAL-B"),
    });

    repository.registerGuardianLink({
      id_acudiente: guardianA,
      id_estudiante: studentA,
      nombres: "Marta",
      apellidos: "Gómez",
      documento_blind_index: service.computeDocumentBlindIndex("1.088.111.222"),
      parentesco: "MADRE",
      es_tutor_principal: true,
      orden_notificacion: 1,
    });

    repository.registerAuthorizedAdultLink({
      id_autorizado: authValid,
      id_estudiante: studentA,
      nombres: "Elena",
      apellidos: "Restrepo",
      documento_blind_index: service.computeDocumentBlindIndex("42098765"),
      parentesco: "ABUELA",
      prioridad_retiro: 1,
      adulto_activo: true,
      autorizacion_activa: true,
      autorizado_hasta: new Date(Date.now() + 86_400_000),
      expediente_revocado: false,
    });

    repository.registerAuthorizedAdultLink({
      id_autorizado: authExpired,
      id_estudiante: studentA,
      nombres: "Carlos",
      apellidos: "Vencido",
      documento_blind_index: service.computeDocumentBlindIndex("1088999000"),
      parentesco: "TIO",
      prioridad_retiro: 2,
      adulto_activo: true,
      autorizacion_activa: true,
      autorizado_hasta: new Date(Date.now() - 3_600_000),
      expediente_revocado: false,
    });

    repository.registerAuthorizedAdultLink({
      id_autorizado: authRevoked,
      id_estudiante: studentA,
      nombres: "Andrés",
      apellidos: "Revocado",
      documento_blind_index: service.computeDocumentBlindIndex("1088777666"),
      parentesco: "TIO",
      prioridad_retiro: 3,
      adulto_activo: true,
      autorizacion_activa: true,
      autorizado_hasta: null,
      expediente_revocado: true,
    });

    repository.registerSchoolCoordinator({
      id_coordinador: coordinatorA,
      id_colegio: schoolA,
      nombres: "Diana",
      apellidos: "Coordinadora",
      cargo: "Coordinadora de Convivencia",
    });
    repository.registerSchoolCoordinator({
      id_coordinador: coordinatorB,
      id_colegio: schoolB,
      nombres: "Jorge",
      apellidos: "OtroColegio",
      cargo: "Rector",
    });
  });

  it("valida ACUDIENTE normalizando el documento contra blind index (1.088.111.222 === 1088111222)", async () => {
    const result = await service.validateReceptorForDelivery({
      id_estudiante: studentA,
      tipo_receptor: ReceptorType.ACUDIENTE,
      documento_receptor: "1088 111 222",
      tipo_recorrido: "TARDE",
    });

    expect(result.autorizado).toBe(true);
    expect(result.tipo_receptor).toBe(ReceptorType.ACUDIENTE);
    expect(result.id_acudiente).toBe(guardianA);
    expect(result.id_autorizado).toBeNull();
    expect(result.nombre_receptor).toBe("Marta Gómez");
  });

  it("valida ADULTO_AUTORIZADO vigente no vencido ni revocado y contabiliza RN-04", async () => {
    const result = await service.validateReceptorForDelivery({
      id_estudiante: studentA,
      tipo_receptor: ReceptorType.ADULTO_AUTORIZADO,
      documento_receptor: "42.098.765",
      tipo_recorrido: "TARDE",
    });

    expect(result.autorizado).toBe(true);
    expect(result.tipo_receptor).toBe(ReceptorType.ADULTO_AUTORIZADO);
    expect(result.id_autorizado).toBe(authValid);
    expect(result.autorizados_activos_estudiante).toBe(1);
  });

  it("valida SEDE_EDUCATIVA únicamente en recorrido MANANA y la rechaza en TARDE", async () => {
    const okMorning = await service.validateReceptorForDelivery({
      id_estudiante: studentA,
      tipo_receptor: ReceptorType.SEDE_EDUCATIVA,
      tipo_recorrido: "MANANA",
    });
    expect(okMorning.autorizado).toBe(true);
    expect(okMorning.tipo_receptor).toBe(ReceptorType.SEDE_EDUCATIVA);

    await expect(
      service.validateReceptorForDelivery({
        id_estudiante: studentA,
        tipo_receptor: ReceptorType.SEDE_EDUCATIVA,
        tipo_recorrido: "TARDE",
      }),
    ).rejects.toThrow(IncompatibleTripDirectionError);
  });

  it("rechaza de forma segura autorizado vencido, revocado, inexistente o sin vínculo con el hermano", async () => {
    await expect(
      service.validateReceptorForDelivery({
        id_estudiante: studentA,
        tipo_receptor: ReceptorType.ADULTO_AUTORIZADO,
        documento_receptor: "1088999000",
        tipo_recorrido: "TARDE",
      }),
    ).rejects.toThrow(AuthorizationExpiredError);

    await expect(
      service.validateReceptorForDelivery({
        id_estudiante: studentA,
        tipo_receptor: ReceptorType.ADULTO_AUTORIZADO,
        documento_receptor: "1088777666",
        tipo_recorrido: "TARDE",
      }),
    ).rejects.toThrow(ReceptorInactiveOrRevokedError);

    await expect(
      service.validateReceptorForDelivery({
        id_estudiante: studentA,
        tipo_receptor: ReceptorType.ADULTO_AUTORIZADO,
        documento_receptor: "999999999",
        tipo_recorrido: "TARDE",
      }),
    ).rejects.toThrow(ReceptorUnauthorizedError);

    // Mitigación de riesgo de hermanos: autorizado para studentA NO es válido para studentB
    await expect(
      service.validateReceptorForDelivery({
        id_estudiante: studentB,
        tipo_receptor: ReceptorType.ADULTO_AUTORIZADO,
        documento_receptor: "42098765",
        tipo_recorrido: "TARDE",
      }),
    ).rejects.toThrow(ReceptorUnauthorizedError);
  });

  it("bloquea inmediatamente ante alerta judicial activa aunque coincida con un acudiente o autorizado", async () => {
    repository.registerJudicialAlert({
      id_alerta: makeUuid(901),
      id_estudiante: studentA,
      radicado_medida: "RAD-2026-0042",
      individuo_blind_index: service.computeDocumentBlindIndex("1088111222"),
      activa: true,
      eliminado_soft: false,
    });

    await expect(
      service.validateReceptorForDelivery({
        id_estudiante: studentA,
        tipo_receptor: ReceptorType.ACUDIENTE,
        documento_receptor: "1088111222",
        tipo_recorrido: "TARDE",
      }),
    ).rejects.toThrow(JudicialAlertBlockedError);
  });

  it("aplica fail-safe ante inconsistencia RN-04 (> 3 autorizados activos) y rechaza al registrar un 4to autorizado activo", async () => {
    // 4to registro en repositorio falla por RN-04
    expect(() =>
      repository.registerAuthorizedAdultLink({
        id_autorizado: makeUuid(304),
        id_estudiante: studentA,
        nombres: "Cuarto",
        apellidos: "Excedido",
        documento_blind_index: service.computeDocumentBlindIndex("55555555"),
        parentesco: "VECINO",
        prioridad_retiro: 4,
        adulto_activo: true,
        autorizacion_activa: true,
        autorizado_hasta: new Date(Date.now() + 86_400_000),
        expediente_revocado: false,
      }),
    ).toThrow(AuthorizedAdultsLimitExceededError);

    // Simular anomalía en almacenamiento con 4 autorizados activos vigentes para studentB
    for (let i = 1; i <= 4; i++) {
      repository.registerAuthorizedAdultLink(
        {
          id_autorizado: makeUuid(350 + i),
          id_estudiante: studentB,
          nombres: `Adulto${i}`,
          apellidos: "Test",
          documento_blind_index: service.computeDocumentBlindIndex(
            `880000${i}`,
          ),
          parentesco: "FAMILIAR",
          prioridad_retiro: i,
          adulto_activo: true,
          autorizacion_activa: true,
          autorizado_hasta: new Date(Date.now() + 86_400_000),
          expediente_revocado: false,
        },
        true, // bypass en seed para probar defensa fail-safe en validación
      );
    }

    await expect(
      service.validateReceptorForDelivery({
        id_estudiante: studentB,
        tipo_receptor: ReceptorType.ADULTO_AUTORIZADO,
        documento_receptor: "8800001",
        tipo_recorrido: "TARDE",
      }),
    ).rejects.toThrow(AuthorizedAdultsLimitExceededError);
  });

  it("rechaza documento ausente, blind index contradictorio, estudiante inexistente y coordinador de otro colegio", async () => {
    await expect(
      service.validateReceptorForDelivery({
        id_estudiante: studentA,
        tipo_receptor: ReceptorType.ACUDIENTE,
        tipo_recorrido: "TARDE",
      }),
    ).rejects.toThrow(ReceptorUnauthorizedError);

    // Documento y blind index contradictorios -> fail-safe reject
    await expect(
      service.validateReceptorForDelivery({
        id_estudiante: studentA,
        tipo_receptor: ReceptorType.ACUDIENTE,
        documento_receptor: "1088111222",
        documento_blind_index: "f".repeat(64),
        tipo_recorrido: "TARDE",
      }),
    ).rejects.toThrow(ReceptorUnauthorizedError);

    await expect(
      service.validateReceptorForDelivery({
        id_estudiante: makeUuid(9999),
        tipo_receptor: ReceptorType.ACUDIENTE,
        documento_receptor: "1088111222",
        tipo_recorrido: "TARDE",
      }),
    ).rejects.toThrow(StudentNotFoundError);

    const validCoord = await service.validateSchoolCoordinator({
      id_estudiante: studentA,
      id_coordinador: coordinatorA,
    });
    expect(validCoord.id_coordinador).toBe(coordinatorA);

    await expect(
      service.validateSchoolCoordinator({
        id_estudiante: studentA,
        id_coordinador: coordinatorB,
      }),
    ).rejects.toThrow(CoordinatorUnauthorizedError);
  });
});
