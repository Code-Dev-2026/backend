import { Injectable } from "@nestjs/common";
import { UserRecord } from "./domain/auth.models";
import { RefreshTokenService } from "./refresh-token.service";
import { TokenService, TokenSubject } from "./token.service";

export const ACCESS_TOKEN_TTL_SECONDS = 900;

export interface PublicUser {
  id_usuario: string;
  email: string;
  roles: string[];
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: PublicUser;
}

function toSubject(user: UserRecord): TokenSubject {
  return {
    id_usuario: user.id_usuario,
    email: user.email,
    roles: [...user.roles],
  };
}

/** Orquesta la emisión de sesiones: Access Token (JWT) + Refresh Token. */
@Injectable()
export class SessionService {
  constructor(
    private readonly tokenService: TokenService,
    private readonly refreshTokenService: RefreshTokenService,
  ) {}

  /**
   * Abre una sesión nueva (familia de refresh tokens nueva) e INVALIDA las
   * sesiones previas del usuario: solo queda viva la del último login.
   */
  async open(user: UserRecord, mfaVerified: boolean): Promise<AuthSession> {
    await this.refreshTokenService.revokeAllForUser(user.id_usuario);
    const accessToken = await this.signAccess(user, mfaVerified);
    const refresh = await this.refreshTokenService.issue(user.id_usuario);

    return {
      accessToken,
      refreshToken: refresh.token,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      user: this.publicUser(user),
    };
  }

  signAccess(user: UserRecord, mfaVerified: boolean): Promise<string> {
    return this.tokenService.signAccessToken(toSubject(user), mfaVerified);
  }

  /** Token provisional que solo sirve para completar el desafío OTP. */
  challenge(user: UserRecord, challengeId: string): Promise<string> {
    return this.tokenService.signMfaChallengeToken(
      toSubject(user),
      challengeId,
    );
  }

  publicUser(user: UserRecord): PublicUser {
    return {
      id_usuario: user.id_usuario,
      email: user.email,
      roles: [...user.roles],
    };
  }
}
