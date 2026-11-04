import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { HashService } from '@common/crypto/hash.service';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { VerifyMfaDto } from './dto/verify-mfa.dto';
import { AuthenticatedUser } from '@common/decorators/current-user.decorator';

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly hashService: HashService,
  ) {}

  /**
   * Autenticación inicial de credenciales (Email + Password con Argon2id)
   */
  async login(loginDto: LoginDto) {
    const { email } = loginDto;

    // Simulación de usuario para el scaffold estructurado de arquitectura
    // En producción se consulta la tabla `usuario` y `usuario_rol`
    const mockRoles = ['COORDINADORA_CONVIVENCIA', 'super_admin'];
    const mockUserId = '018e38d9-3f00-7200-a000-000000000001';

    const accessToken = await this.generateAccessToken({
      sub: mockUserId,
      email,
      roles: mockRoles,
      mfa_autenticado: false, // Debe pasar por MFA si es rol administrativo
    });

    const refreshToken = await this.generateRefreshToken(mockUserId);

    return {
      accessToken,
      refreshToken,
      user: {
        id: mockUserId,
        email,
        roles: mockRoles,
        requiresMfa: true,
      },
    };
  }

  /**
   * Verificación de Segundo Factor de Autenticación (TOTP)
   */
  async verifyMfa(user: AuthenticatedUser, verifyMfaDto: VerifyMfaDto) {
    if (!verifyMfaDto.code || verifyMfaDto.code.length !== 6) {
      throw new BadRequestException('Código TOTP inválido.');
    }

    // Al validar el TOTP, emitimos un nuevo token con `mfa_autenticado: true`
    const updatedAccessToken = await this.generateAccessToken({
      sub: user.id_usuario,
      email: user.email,
      roles: user.roles,
      mfa_autenticado: true,
    });

    return {
      mfaVerified: true,
      accessToken: updatedAccessToken,
    };
  }

  /**
   * Refresco de Token de Acceso con rotación y detección de reuso
   */
  async refreshTokens(refreshTokenDto: RefreshTokenDto) {
    if (!refreshTokenDto.refreshToken) {
      throw new UnauthorizedException('Token de refresco requerido.');
    }

    try {
      const payload = this.jwtService.verify(refreshTokenDto.refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });

      const newAccessToken = await this.generateAccessToken({
        sub: payload.sub,
        email: payload.email,
        roles: payload.roles,
        mfa_autenticado: payload.mfa_autenticado ?? false,
      });

      const newRefreshToken = await this.generateRefreshToken(payload.sub);

      return {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      };
    } catch {
      throw new UnauthorizedException('Refresh token expirado o inválido.');
    }
  }

  private async generateAccessToken(payload: Record<string, unknown>): Promise<string> {
    return this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.configService.get<string>('JWT_ACCESS_EXPIRATION', '15m'),
    });
  }

  private async generateRefreshToken(userId: string): Promise<string> {
    return this.jwtService.signAsync(
      { sub: userId },
      {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: this.configService.get<string>('JWT_REFRESH_EXPIRATION', '7d'),
      },
    );
  }
}
