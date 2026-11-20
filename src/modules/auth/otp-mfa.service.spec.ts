import { ConfigService } from "@nestjs/config";
import { AesEncryptionService } from "@common/crypto/aes-encryption.service";
import { HashService } from "@common/crypto/hash.service";
import { OtpMfaService } from "./otp-mfa.service";
import { InMemoryMfaRepository } from "./infrastructure/in-memory-mfa.repository";
import { base32Decode, generateTotp } from "./infrastructure/totp";

describe("OtpMfaService", () => {
  const idUsuario = "018e38d9-3f00-7200-a000-000000000001";
  const config = {
    get: jest.fn((_key: string, defaultValue?: string) => defaultValue),
  } as unknown as ConfigService;

  let repository: InMemoryMfaRepository;
  let service: OtpMfaService;

  beforeEach(() => {
    repository = new InMemoryMfaRepository();
    service = new OtpMfaService(
      repository,
      new AesEncryptionService(config),
      new HashService(),
    );
  });

  it("debe enrolar guardando el secreto cifrado (no en claro)", async () => {
    const enrollment = await service.enroll(idUsuario, "coord@sanbenito.edu.co");
    const stored = await repository.findByUserId(idUsuario);

    expect(stored?.confirmado).toBe(false);
    expect(stored?.secret_cifrado).toMatch(/^v1:/);
    expect(stored?.secret_cifrado).not.toContain(enrollment.secretBase32);
    expect(enrollment.otpauthUri).toContain("otpauth://totp/");
    expect(enrollment.otpauthUri).toContain(`secret=${enrollment.secretBase32}`);
  });

  it("debe guardar los códigos de respaldo solo como hash", async () => {
    const { backupCodes } = await service.enroll(idUsuario, "coord@x.co");
    const stored = await repository.findByUserId(idUsuario);

    expect(backupCodes).toHaveLength(8);
    expect(stored?.backup_codes_hashes).toHaveLength(8);
    for (const code of backupCodes) {
      expect(stored?.backup_codes_hashes).not.toContain(code);
    }
  });

  it("debe aceptar un código TOTP correcto y confirmar el secreto", async () => {
    const { secretBase32 } = await service.enroll(idUsuario, "coord@x.co");
    const code = generateTotp(base32Decode(secretBase32));

    await expect(service.verify(idUsuario, code)).resolves.toBe(true);
    expect((await repository.findByUserId(idUsuario))?.confirmado).toBe(true);
  });

  it("debe rechazar un código TOTP incorrecto", async () => {
    const { secretBase32 } = await service.enroll(idUsuario, "coord@x.co");
    const valid = generateTotp(base32Decode(secretBase32));
    const wrong = valid === "000000" ? "000001" : "000000";

    await expect(service.verify(idUsuario, wrong)).resolves.toBe(false);
  });

  it("debe rechazar un código TOTP de otro momento (fuera de ventana)", async () => {
    const { secretBase32 } = await service.enroll(idUsuario, "coord@x.co");
    const old = generateTotp(base32Decode(secretBase32), Date.now() - 120_000);

    await expect(service.verify(idUsuario, old)).resolves.toBe(false);
  });

  it("debe impedir reusar el mismo código TOTP (un solo uso)", async () => {
    const { secretBase32 } = await service.enroll(idUsuario, "coord@x.co");
    const code = generateTotp(base32Decode(secretBase32));

    await expect(service.verify(idUsuario, code)).resolves.toBe(true);
    await expect(service.verify(idUsuario, code)).resolves.toBe(false);
  });

  it("debe aceptar un código de respaldo una sola vez", async () => {
    const { backupCodes } = await service.enroll(idUsuario, "coord@x.co");

    await expect(service.verify(idUsuario, backupCodes[0])).resolves.toBe(true);
    await expect(service.verify(idUsuario, backupCodes[0])).resolves.toBe(false);
    await expect(service.verify(idUsuario, backupCodes[1])).resolves.toBe(true);
    expect(
      (await repository.findByUserId(idUsuario))?.backup_codes_hashes,
    ).toHaveLength(6);
  });

  it("debe rechazar si el usuario no tiene MFA enrolado", async () => {
    await expect(service.verify(idUsuario, "123456")).resolves.toBe(false);
  });

  it("debe rechazar códigos vacíos o con formato inválido", async () => {
    await service.enroll(idUsuario, "coord@x.co");

    await expect(service.verify(idUsuario, "")).resolves.toBe(false);
    await expect(service.verify(idUsuario, "12345")).resolves.toBe(false);
    await expect(service.verify(idUsuario, "abcdefghij")).resolves.toBe(false);
  });
});
