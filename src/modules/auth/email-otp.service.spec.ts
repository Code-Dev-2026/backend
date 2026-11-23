import { ServiceUnavailableException } from "@nestjs/common";
import { HashService } from "@common/crypto/hash.service";
import { MailerService } from "../mailer/mailer.service";
import {
  EMAIL_OTP_MAX_ATTEMPTS,
  EMAIL_OTP_TTL_SECONDS,
  EmailOtpService,
} from "./email-otp.service";
import { InMemoryEmailOtpRepository } from "./infrastructure/in-memory-email-otp.repository";

describe("EmailOtpService", () => {
  const user = {
    id_usuario: "018e38d9-3f00-7200-a000-000000000002",
    email: "acudiente@correo.co",
  };

  let repository: InMemoryEmailOtpRepository;
  let mailer: { sendOtpCode: jest.Mock };
  let service: EmailOtpService;

  beforeEach(() => {
    repository = new InMemoryEmailOtpRepository();
    mailer = { sendOtpCode: jest.fn().mockResolvedValue(undefined) };
    service = new EmailOtpService(
      repository,
      new HashService(),
      mailer as unknown as MailerService,
    );
  });

  afterEach(() => jest.useRealTimers());

  async function emitir() {
    const issued = await service.issue(user);
    const code = mailer.sendOtpCode.mock.calls.at(-1)[1] as string;
    return { ...issued, code };
  }

  it("envía un código numérico de 6 dígitos al correo con caducidad de 300 s", async () => {
    const { code, expiresIn, challengeId } = await emitir();

    expect(mailer.sendOtpCode).toHaveBeenCalledWith(
      user.email,
      expect.stringMatching(/^\d{6}$/),
      300,
    );
    expect(expiresIn).toBe(EMAIL_OTP_TTL_SECONDS);

    const record = await repository.findById(challengeId);
    expect(record?.code_hash).not.toContain(code);
    expect(record?.code_hash).toHaveLength(64);
  });

  it("acepta el código correcto una sola vez", async () => {
    const { challengeId, code } = await emitir();

    await expect(
      service.verify(user.id_usuario, challengeId, code),
    ).resolves.toBe(true);
    await expect(
      service.verify(user.id_usuario, challengeId, code),
    ).resolves.toBe(false);
  });

  it("rechaza un código incorrecto", async () => {
    const { challengeId, code } = await emitir();
    const wrong = code === "000000" ? "000001" : "000000";

    await expect(
      service.verify(user.id_usuario, challengeId, wrong),
    ).resolves.toBe(false);
  });

  it("rechaza el código pasado el segundo 300 (caducidad estricta)", async () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 10, 22, 12, 0, 0) });
    const { challengeId, code } = await emitir();

    jest.setSystemTime(Date.now() + 299_000);
    // Sigue vigente a los 299 s
    const record = await repository.findById(challengeId);
    expect(record && Date.now() < record.expira_en.getTime()).toBe(true);

    jest.setSystemTime(Date.now() + 1_000); // 300 s exactos
    await expect(
      service.verify(user.id_usuario, challengeId, code),
    ).resolves.toBe(false);
  });

  it("acepta el código justo antes de caducar", async () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 10, 22, 12, 0, 0) });
    const { challengeId, code } = await emitir();

    jest.setSystemTime(Date.now() + 299_000);
    await expect(
      service.verify(user.id_usuario, challengeId, code),
    ).resolves.toBe(true);
  });

  it(`invalida el desafío tras ${EMAIL_OTP_MAX_ATTEMPTS} intentos fallidos`, async () => {
    const { challengeId, code } = await emitir();
    const wrong = code === "000000" ? "000001" : "000000";

    for (let i = 0; i < EMAIL_OTP_MAX_ATTEMPTS; i++) {
      await service.verify(user.id_usuario, challengeId, wrong);
    }

    await expect(
      service.verify(user.id_usuario, challengeId, code),
    ).resolves.toBe(false);
  });

  it("invalida el código anterior al emitir uno nuevo", async () => {
    const first = await emitir();
    const second = await emitir();

    await expect(
      service.verify(user.id_usuario, first.challengeId, first.code),
    ).resolves.toBe(false);
    await expect(
      service.verify(user.id_usuario, second.challengeId, second.code),
    ).resolves.toBe(true);
  });

  it("rechaza el desafío de otro usuario", async () => {
    const { challengeId, code } = await emitir();

    await expect(
      service.verify("otro-usuario", challengeId, code),
    ).resolves.toBe(false);
  });

  it("devuelve 503 y no deja desafío si el correo no se pudo enviar", async () => {
    mailer.sendOtpCode.mockRejectedValueOnce(new Error("SMTP caído"));
    const replace = jest.spyOn(repository, "replaceForUser");

    await expect(service.issue(user)).rejects.toThrow(
      ServiceUnavailableException,
    );

    const saved = replace.mock.calls[0][0];
    await expect(repository.findById(saved.id_desafio)).resolves.toBeNull();
  });
});
