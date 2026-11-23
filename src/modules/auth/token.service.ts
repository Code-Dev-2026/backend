import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { AuthenticatedUser } from "@common/decorators/current-user.decorator";

export const ACCESS_TOKEN_TTL = "15m"; // ASVS V3.2: tokens de sesión efímeros
export const MFA_CHALLENGE_TTL = "5m"; // ventana del desafío OTP

type TokenType = "access" | "mfa_challenge";

interface TokenPayload {
  sub: string;
  email: string;
  roles: string[];
  mfa: boolean;
  typ: TokenType;
  /** Id del desafío OTP (solo en el token provisional). */
  cid?: string;
}

export interface TokenSubject {
  id_usuario: string;
  email: string;
  roles: string[];
}

export interface MfaChallengeSubject extends TokenSubject {
  challengeId: string;
}

/**
 * Emisión y validación de JWT (SRP: solo tokens, sin credenciales ni OTP).
 * - Access Token (15 min): sesión completa.
 * - Token provisional MFA (5 min): solo sirve para POST /auth/verify-otp
 *   y va ligado al desafío OTP enviado por correo (claim `cid`).
 */
@Injectable()
export class TokenService {
  constructor(private readonly jwtService: JwtService) {}

  signAccessToken(
    subject: TokenSubject,
    mfaVerified: boolean,
  ): Promise<string> {
    return this.sign(subject, "access", mfaVerified, ACCESS_TOKEN_TTL);
  }

  signMfaChallengeToken(
    subject: TokenSubject,
    challengeId: string,
  ): Promise<string> {
    return this.sign(
      subject,
      "mfa_challenge",
      false,
      MFA_CHALLENGE_TTL,
      challengeId,
    );
  }

  async verifyAccessToken(token: string): Promise<AuthenticatedUser> {
    const payload = await this.verify(token, "access");
    return {
      id_usuario: payload.sub,
      email: payload.email,
      roles: payload.roles,
      mfa_autenticado: payload.mfa,
    };
  }

  async verifyMfaChallengeToken(token: string): Promise<MfaChallengeSubject> {
    const payload = await this.verify(token, "mfa_challenge");
    if (!payload.cid) {
      throw new UnauthorizedException("Tipo de token no válido.");
    }
    return {
      id_usuario: payload.sub,
      email: payload.email,
      roles: payload.roles,
      challengeId: payload.cid,
    };
  }

  private sign(
    subject: TokenSubject,
    typ: TokenType,
    mfa: boolean,
    expiresIn: string,
    challengeId?: string,
  ): Promise<string> {
    const payload: TokenPayload = {
      sub: subject.id_usuario,
      email: subject.email,
      roles: subject.roles,
      mfa,
      typ,
      ...(challengeId ? { cid: challengeId } : {}),
    };
    return this.jwtService.signAsync(payload, {
      expiresIn,
      algorithm: "HS256",
    });
  }

  private async verify(token: string, expected: TokenType) {
    try {
      const payload = await this.jwtService.verifyAsync<TokenPayload>(token, {
        algorithms: ["HS256"],
      });
      if (payload.typ !== expected) {
        throw new UnauthorizedException("Tipo de token no válido.");
      }
      return payload;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException("Token inválido o expirado.");
    }
  }
}
