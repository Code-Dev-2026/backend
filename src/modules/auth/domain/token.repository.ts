import { RefreshTokenRecord } from "./auth.models";

export type ConsumeStatus = "OK" | "NOT_FOUND" | "EXPIRED" | "REUSED";

export interface ConsumeResult {
  status: ConsumeStatus;
  token: RefreshTokenRecord | null;
}

/** Puerto de persistencia de refresh tokens (DIP). */
export interface ITokenRepository {
  save(token: RefreshTokenRecord): Promise<void>;

  /**
   * Consume un refresh token de forma ATÓMICA (control de concurrencia):
   * solo UNA llamada concurrente puede obtener "OK" para el mismo hash.
   * En PostgreSQL equivale a un UPDATE ... SET revocado = TRUE
   * WHERE token_hash = $1 AND revocado = FALSE RETURNING *.
   * - "REUSED": el token ya estaba revocado (posible robo).
   */
  consumeByHash(tokenHash: string): Promise<ConsumeResult>;

  /** Revoca todos los tokens de una familia (detección de robo). */
  revokeFamily(familyId: string): Promise<void>;

  /**
   * Cierra todas las sesiones del usuario ELIMINANDO sus refresh tokens
   * (DELETE ... WHERE id_usuario = $1). Se eliminan en vez de marcarse como
   * revocados para que presentar uno viejo dé NOT_FOUND y no dispare una
   * falsa alarma de reutilización.
   */
  revokeAllForUser(idUsuario: string): Promise<void>;
}

export const TOKEN_REPOSITORY = Symbol("ITokenRepository");
