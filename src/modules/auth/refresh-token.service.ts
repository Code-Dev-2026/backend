import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { randomBytes, randomUUID } from "crypto";
import { HashService } from "@common/crypto/hash.service";
import { ITokenRepository, TOKEN_REPOSITORY } from "./domain/token.repository";
import {
  ISecurityAuditPort,
  SECURITY_AUDIT,
} from "./domain/security-audit.port";

export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

export interface IssuedRefreshToken {
  /** Token en claro: se entrega al cliente una sola vez, nunca se guarda. */
  token: string;
  familyId: string;
}

export interface RotatedRefreshToken extends IssuedRefreshToken {
  idUsuario: string;
}

/**
 * Refresh tokens con rotación y detección de reutilización (ASVS V3.3).
 * - Solo se persiste el SHA-256 del token.
 * - Cada uso consume el token y emite uno nuevo en la misma familia.
 * - Reusar un token ya consumido revoca TODA la familia y queda auditado.
 */
@Injectable()
export class RefreshTokenService {
  constructor(
    @Inject(TOKEN_REPOSITORY)
    private readonly tokenRepository: ITokenRepository,
    private readonly hashService: HashService,
    @Inject(SECURITY_AUDIT)
    private readonly securityAudit: ISecurityAuditPort,
  ) {}

  /** Emite un refresh token nuevo (familia nueva si no se indica una). */
  async issue(
    idUsuario: string,
    familyId: string = randomUUID(),
  ): Promise<IssuedRefreshToken> {
    const token = randomBytes(48).toString("base64url");

    await this.tokenRepository.save({
      id_token: randomUUID(),
      id_usuario: idUsuario,
      family_id: familyId,
      token_hash: this.hashService.sha256(token),
      revocado: false,
      expira_en: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    });

    return { token, familyId };
  }

  /** Consume el token presentado y emite el siguiente de la cadena. */
  async rotate(presentedToken: string): Promise<RotatedRefreshToken> {
    if (!presentedToken) {
      throw new UnauthorizedException("Refresh token inválido.");
    }

    const { status, token } = await this.tokenRepository.consumeByHash(
      this.hashService.sha256(presentedToken),
    );

    if (status === "NOT_FOUND" || status === "EXPIRED" || !token) {
      throw new UnauthorizedException("Refresh token inválido o expirado.");
    }

    if (status === "REUSED") {
      await this.tokenRepository.revokeFamily(token.family_id);
      await this.securityAudit.registrarIncidente({
        tipo_evento: "REFRESH_TOKEN_REUSE_DETECTED",
        id_usuario: token.id_usuario,
        payload: {
          family_id: token.family_id,
          id_token: token.id_token,
          accion: "FAMILIA_REVOCADA_Y_SESION_BLOQUEADA",
        },
      });
      throw new UnauthorizedException(
        "Sesión revocada por seguridad. Inicie sesión nuevamente.",
      );
    }

    const next = await this.issue(token.id_usuario, token.family_id);
    return { ...next, idUsuario: token.id_usuario };
  }

  /** Revoca una familia completa (p. ej. usuario desactivado en plena sesión). */
  async revokeFamily(familyId: string): Promise<void> {
    await this.tokenRepository.revokeFamily(familyId);
  }

  /** Revoca todas las sesiones previas del usuario (login nuevo). */
  async revokeAllForUser(idUsuario: string): Promise<void> {
    await this.tokenRepository.revokeAllForUser(idUsuario);
  }
}
