import { Injectable } from "@nestjs/common";
import { RefreshTokenRecord } from "../domain/auth.models";
import { ConsumeResult, ITokenRepository } from "../domain/token.repository";

/**
 * Adaptador TEMPORAL en memoria de ITokenRepository.
 * Existe para que la app arranque mientras no hay capa de persistencia SQL.
 * Se reemplaza por una implementación PostgreSQL cambiando un solo provider
 * (TOKEN_REPOSITORY) en AuthModule. Los datos se pierden al reiniciar.
 */
@Injectable()
export class InMemoryTokenRepository implements ITokenRepository {
  private readonly tokens = new Map<string, RefreshTokenRecord>();

  async save(token: RefreshTokenRecord): Promise<void> {
    this.tokens.set(token.token_hash, { ...token });
  }

  async consumeByHash(tokenHash: string): Promise<ConsumeResult> {
    const token = this.tokens.get(tokenHash);
    if (!token) {
      return { status: "NOT_FOUND", token: null };
    }
    if (token.revocado) {
      return { status: "REUSED", token: { ...token } };
    }
    if (token.expira_en.getTime() <= Date.now()) {
      return { status: "EXPIRED", token: { ...token } };
    }
    // Sin await entre la lectura y la marca: atómico en el event loop.
    token.revocado = true;
    return { status: "OK", token: { ...token } };
  }

  async revokeFamily(familyId: string): Promise<void> {
    for (const token of this.tokens.values()) {
      if (token.family_id === familyId) {
        token.revocado = true;
      }
    }
  }

  async revokeAllForUser(idUsuario: string): Promise<void> {
    for (const [hash, token] of this.tokens) {
      if (token.id_usuario === idUsuario) {
        this.tokens.delete(hash);
      }
    }
  }
}
