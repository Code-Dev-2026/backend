import { ConsoleLogger } from "@nestjs/common";
import { sanitize } from "./pii-sanitizer";

/**
 * Contextos exentos del sanitizado. Solo el transporte de correo de
 * DESARROLLO (sin SMTP), que imprime el OTP a propósito; en producción
 * ese transporte nunca se crea.
 */
const EXEMPT_CONTEXTS = new Set(["MailerService:dev"]);

/**
 * Logger global que sanitiza PII y secretos antes de escribir cualquier
 * mensaje (incluidos los de Nest y los stack traces).
 * Se instala en main.ts con app.useLogger().
 */
export class SanitizingLogger extends ConsoleLogger {
  log(message: unknown, ...params: unknown[]): void {
    super.log(...this.clean(message, params));
  }

  error(message: unknown, ...params: unknown[]): void {
    super.error(...this.clean(message, params));
  }

  warn(message: unknown, ...params: unknown[]): void {
    super.warn(...this.clean(message, params));
  }

  debug(message: unknown, ...params: unknown[]): void {
    super.debug(...this.clean(message, params));
  }

  verbose(message: unknown, ...params: unknown[]): void {
    super.verbose(...this.clean(message, params));
  }

  fatal(message: unknown, ...params: unknown[]): void {
    super.fatal(...this.clean(message, params));
  }

  private clean(message: unknown, params: unknown[]): [unknown, ...unknown[]] {
    const context = params.at(-1);
    if (
      typeof context === "string" &&
      EXEMPT_CONTEXTS.has(context) &&
      process.env.NODE_ENV !== "production"
    ) {
      return [message, ...params];
    }
    return [sanitize(message), ...params.map((p) => sanitize(p))];
  }
}
