import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Abstracción mínima del transporte (permite sustituirlo en pruebas). */
export interface MailTransport {
  sendMail(message: MailMessage & { from: string }): Promise<unknown>;
}

export const MAIL_TRANSPORT = Symbol("MailTransport");

/**
 * Crea el transporte SMTP a partir del entorno.
 * - Con SMTP_HOST: SMTP real (nodemailer).
 * - Sin SMTP_HOST fuera de producción: transporte de desarrollo que solo
 *   escribe en el log, para poder probar el login sin servidor de correo.
 * - Sin SMTP_HOST en producción: error de arranque (el OTP nunca llegaría).
 */
export function createMailTransport(config: ConfigService): MailTransport {
  const host = config.get<string>("SMTP_HOST");

  if (!host) {
    if (config.get<string>("NODE_ENV") === "production") {
      throw new Error(
        "SMTP_HOST no está definido: el envío de OTP por correo es obligatorio en producción.",
      );
    }
    return new LogMailTransport();
  }

  const user = config.get<string>("SMTP_USER");
  return nodemailer.createTransport({
    host,
    port: Number(config.get("SMTP_PORT") ?? 587),
    secure: String(config.get("SMTP_SECURE") ?? "false") === "true",
    auth: user
      ? { user, pass: config.get<string>("SMTP_PASSWORD") ?? "" }
      : undefined,
    disableFileAccess: true,
    disableUrlAccess: true,
  }) as unknown as MailTransport;
}

/** Transporte de desarrollo: no envía nada, deja el mensaje en el log. */
export class LogMailTransport implements MailTransport {
  private readonly logger = new Logger("MailerService:dev");

  async sendMail(message: MailMessage & { from: string }): Promise<void> {
    this.logger.warn(
      `[SIN SMTP] Correo a ${message.to} | ${message.subject}\n${message.text}`,
    );
  }
}

/**
 * Servicio de correo saliente. Su responsabilidad es componer y despachar
 * mensajes; la generación y validación del OTP vive en EmailOtpService.
 */
@Injectable()
export class MailerService {
  private readonly from: string;

  constructor(
    private readonly transport: MailTransport,
    config: ConfigService,
  ) {
    this.from =
      config.get<string>("MAIL_FROM") ??
      "Camino Seguro <no-reply@caminoseguro.edu.co>";
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ ...message, from: this.from });
  }

  /** Envía el código OTP de 6 dígitos del segundo factor. */
  async sendOtpCode(
    to: string,
    code: string,
    ttlSeconds: number,
  ): Promise<void> {
    const minutes = Math.round(ttlSeconds / 60);
    await this.send({
      to,
      subject: `Camino Seguro: tu código de verificación es ${code}`,
      text:
        `Tu código de verificación es: ${code}\n\n` +
        `Vence en ${minutes} minutos y solo se puede usar una vez.\n` +
        `Si no intentaste iniciar sesión, ignora este mensaje y cambia tu contraseña.`,
      html:
        `<p>Tu código de verificación es:</p>` +
        `<p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p>` +
        `<p>Vence en ${minutes} minutos y solo se puede usar una vez.</p>` +
        `<p>Si no intentaste iniciar sesión, ignora este mensaje y cambia tu contraseña.</p>`,
    });
  }
}
