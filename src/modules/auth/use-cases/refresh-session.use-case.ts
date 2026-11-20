import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { requiresMfa } from "../domain/auth-policy";
import { IUserRepository, USER_REPOSITORY } from "../domain/user.repository";
import { RefreshTokenService } from "../refresh-token.service";
import { ACCESS_TOKEN_TTL_SECONDS, SessionService } from "../session.service";

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Caso de uso: renovar la sesión con un refresh token.
 * El token se consume y se reemplaza (rotación). Reusar uno ya consumido
 * revoca toda la familia y queda auditado (lo hace RefreshTokenService).
 */
@Injectable()
export class RefreshSessionUseCase {
  constructor(
    private readonly refreshTokenService: RefreshTokenService,
    private readonly sessionService: SessionService,
    @Inject(USER_REPOSITORY) private readonly userRepository: IUserRepository,
  ) {}

  async execute(refreshToken: string): Promise<RefreshResult> {
    const rotated = await this.refreshTokenService.rotate(refreshToken);

    const user = await this.userRepository.findById(rotated.idUsuario);
    if (!user || user.estado !== "ACTIVO") {
      await this.refreshTokenService.revokeFamily(rotated.familyId);
      throw new UnauthorizedException("Sesión no válida.");
    }

    // Un refresh token solo existe tras completar el login (y el MFA si aplica).
    const accessToken = await this.sessionService.signAccess(
      user,
      requiresMfa(user),
    );

    return {
      accessToken,
      refreshToken: rotated.token,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    };
  }
}
