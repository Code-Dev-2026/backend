import { ConfigService } from '@nestjs/config';
import { JwtModuleAsyncOptions } from '@nestjs/jwt';

export const jwtAsyncConfig: JwtModuleAsyncOptions = {
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => ({
    secret: configService.get<string>('JWT_ACCESS_SECRET'),
    signOptions: {
      expiresIn: configService.get<string>('JWT_ACCESS_EXPIRATION', '15m'),
    },
  }),
};
