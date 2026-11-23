import { ConfigService } from "@nestjs/config";
import {
  createMailTransport,
  LogMailTransport,
  MailerService,
} from "./mailer.service";

function config(values: Record<string, unknown>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

describe("MailerService", () => {
  it("envía el OTP al destinatario con el remitente configurado", async () => {
    const transport = { sendMail: jest.fn().mockResolvedValue(undefined) };
    const mailer = new MailerService(
      transport,
      config({ MAIL_FROM: "CS <no-reply@cs.co>" }),
    );

    await mailer.sendOtpCode("acudiente@correo.co", "482913", 300);

    const sent = transport.sendMail.mock.calls[0][0];
    expect(sent.to).toBe("acudiente@correo.co");
    expect(sent.from).toBe("CS <no-reply@cs.co>");
    expect(sent.text).toContain("482913");
    expect(sent.text).toContain("5 minutos");
    expect(sent.html).toContain("482913");
  });

  it("propaga el error si el transporte falla", async () => {
    const transport = {
      sendMail: jest.fn().mockRejectedValue(new Error("SMTP caído")),
    };
    const mailer = new MailerService(transport, config({}));

    await expect(mailer.sendOtpCode("a@b.co", "123456", 300)).rejects.toThrow(
      "SMTP caído",
    );
  });
});

describe("createMailTransport", () => {
  it("usa el transporte de log en desarrollo si no hay SMTP_HOST", () => {
    expect(
      createMailTransport(config({ NODE_ENV: "development" })),
    ).toBeInstanceOf(LogMailTransport);
  });

  it("falla en producción si no hay SMTP_HOST", () => {
    expect(() =>
      createMailTransport(config({ NODE_ENV: "production" })),
    ).toThrow("SMTP_HOST");
  });

  it("crea un transporte SMTP cuando SMTP_HOST está definido", () => {
    const transport = createMailTransport(
      config({ SMTP_HOST: "smtp.example.com", SMTP_PORT: 587 }),
    );

    expect(transport).not.toBeInstanceOf(LogMailTransport);
    expect(typeof transport.sendMail).toBe("function");
  });
});
