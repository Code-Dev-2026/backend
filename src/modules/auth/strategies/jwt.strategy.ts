import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

export interface JwtPayload {
  sub: string;
  email: string;
  roles: string[];
  mfa_autenticado?: boolean;
  id_colegio?: string;
  id_empresa?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_ACCESS_SECRET') || 'default_secret',
    });
  }

  async validate(payload: JwtPayload) {
    if (!payload.sub || !payload.email) {
      throw new UnauthorizedException('Token de autenticación no válido.');
    }

    return {
      id_usuario: payload.sub,
      email: payload.email,
      roles: payload.roles || [],
      mfa_autenticado: payload.mfa_autenticado ?? false,
      id_colegio: payload.id_colegio,
      id_empresa: payload.id_empresa,
    };
  }
}
