import { EmailOtpRecord } from "./auth.models";

/** Puerto de persistencia de desafíos OTP por correo (DIP). */
export interface IEmailOtpRepository {
  /**
   * Guarda el desafío e INVALIDA cualquier desafío anterior del mismo
   * usuario: solo el último código enviado es válido.
   */
  replaceForUser(record: EmailOtpRecord): Promise<void>;

  findById(idDesafio: string): Promise<EmailOtpRecord | null>;

  /** Suma un intento fallido y devuelve el total. */
  registerFailedAttempt(idDesafio: string): Promise<number>;

  /**
   * Marca el desafío como consumido de forma ATÓMICA: solo una llamada
   * concurrente obtiene `true` (en SQL: UPDATE ... WHERE consumido = FALSE).
   */
  consume(idDesafio: string): Promise<boolean>;

  delete(idDesafio: string): Promise<void>;
}

export const EMAIL_OTP_REPOSITORY = Symbol("IEmailOtpRepository");
