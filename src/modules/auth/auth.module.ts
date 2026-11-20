import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { RolesGuard } from "@common/guards/roles.guard";
import { AuditModule } from "../audit/audit.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { MFA_REPOSITORY } from "./domain/mfa.repository";
import { PASSWORD_HASHER } from "./domain/password-hasher.interface";
import { SECURITY_AUDIT } from "./domain/security-audit.port";
import { TOKEN_REPOSITORY } from "./domain/token.repository";
import { USER_REPOSITORY } from "./domain/user.repository";
import { AppMfaGuard } from "./guards/app-mfa.guard";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { Argon2idPasswordHasher } from "./infrastructure/argon2id-password-hasher";
import { AuditLedgerSecurityAudit } from "./infrastructure/audit-ledger-security-audit";
import { InMemoryMfaRepository } from "./infrastructure/in-memory-mfa.repository";
import { InMemoryTokenRepository } from "./infrastructure/in-memory-token.repository";
import { InMemoryUserRepository } from "./infrastructure/in-memory-user.repository";
import { OtpMfaService } from "./otp-mfa.service";
import { RefreshTokenService } from "./refresh-token.service";
import { SessionService } from "./session.service";
import { TokenService } from "./token.service";
import { LoginUseCase } from "./use-cases/login.use-case";
import { RefreshSessionUseCase } from "./use-cases/refresh-session.use-case";
import { VerifyMfaUseCase } from "./use-cases/verify-mfa.use-case";

/** Secreto que trae por defecto el esquema de entorno: inseguro en producción. */
const DEFAULT_DEV_SECRET = "super_secret_jwt_key_camino_seguro_2026";

function resolveJwtSecret(config: ConfigService): string {
  const secret = config.get<string>("JWT_SECRET");
  if (!secret) {
    throw new Error("JWT_SECRET no está definido.");
  }

  const isProduction = config.get<string>("NODE_ENV") === "production";
  if (isProduction && (secret === DEFAULT_DEV_SECRET || secret.length < 32)) {
    throw new Error(
      "JWT_SECRET inseguro para producción: defina un secreto propio de al menos 32 caracteres.",
    );
  }
  return secret;
}

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: resolveJwtSecret(config),
      }),
    }),
    AuditModule,
  ],
  controllers: [AuthController],
  providers: [
    // Puertos -> adaptadores (cambiar un adaptador no toca la lógica)
    { provide: PASSWORD_HASHER, useClass: Argon2idPasswordHasher },
    { provide: SECURITY_AUDIT, useClass: AuditLedgerSecurityAudit },
    // TEMPORALES en memoria: reemplazar por adaptadores PostgreSQL
    { provide: USER_REPOSITORY, useClass: InMemoryUserRepository },
    { provide: TOKEN_REPOSITORY, useClass: InMemoryTokenRepository },
    { provide: MFA_REPOSITORY, useClass: InMemoryMfaRepository },

    AuthService,
    TokenService,
    RefreshTokenService,
    OtpMfaService,
    SessionService,
    LoginUseCase,
    VerifyMfaUseCase,
    RefreshSessionUseCase,

    // Guards globales. El orden importa: autenticar -> roles -> MFA.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: AppMfaGuard },
  ],
  exports: [AuthService, TokenService],
})
export class AuthModule {}
