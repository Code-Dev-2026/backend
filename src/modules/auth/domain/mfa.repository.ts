import { MfaSecretRecord } from "./auth.models";

/** Puerto de persistencia de secretos MFA (DIP). */
export interface IMfaRepository {
  findByUserId(idUsuario: string): Promise<MfaSecretRecord | null>;
  save(secret: MfaSecretRecord): Promise<void>;
  /** Reemplaza la lista de hashes de códigos de respaldo (uno se consume). */
  updateBackupCodes(idUsuario: string, hashes: string[]): Promise<void>;
}

export const MFA_REPOSITORY = Symbol("IMfaRepository");
