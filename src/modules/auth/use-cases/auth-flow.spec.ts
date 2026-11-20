import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { AesEncryptionService } from "@common/crypto/aes-encryption.service";
import { HashService } from "@common/crypto/hash.service";
import { AuthService } from "../auth.service";
import { IPasswordHasher } from "../domain/password-hasher.interface";
import { InMemoryMfaRepository } from "../infrastructure/in-memory-mfa.repository";
import { InMemoryTokenRepository } from "../infrastructure/in-memory-token.repository";
import { InMemoryUserRepository } from "../infrastructure/in-memory-user.repository";
import { base32Decode, generateTotp } from "../infrastructure/totp";
import { OtpMfaService } from "../otp-mfa.service";
import { RefreshTokenService } from "../refresh-token.service";
import { SessionService } from "../session.service";
import { TokenService } from "../token.service";
import { LoginUseCase } from "./login.use-case";
import { RefreshSessionUseCase } from "./refresh-session.use-case";
import { VerifyMfaUseCase } from "./verify-mfa.use-case";

class FakeHasher implements IPasswordHasher {
  async hash(plain: string) {
    return `fake:${plain}`;
  }
  async verify(plain: string, hash: string) {
    return hash === `fake:${plain}`;
  }
}

describe("Flujo de autenticación (login, MFA y refresh)", () => {
  const PASSWORD = "ContrasenaSegura#2026";
  const acudiente = {
    id_usuario: "018e38d9-3f00-7200-a000-000000000002",
    email: "acudiente@correo.co",
    password_hash: `fake:${PASSWORD}`,
    estado: "ACTIVO" as const,
    mfa_habilitado: false,
    roles: ["ACUDIENTE"],
  };
  const coordinadora = {
    id_usuario: "018e38d9-3f00-7200-a000-000000000001",
    email: "coordinacion@sanbenito.edu.co",
    password_hash: `fake:${PASSWORD}`,
    estado: "ACTIVO" as const,
    mfa_habilitado: true,
    roles: ["COORDINADORA_CONVIVENCIA"],
  };

  let users: InMemoryUserRepository;
  let otp: OtpMfaService;
  let tokens: TokenService;
  let audit: { registrarIncidente: jest.Mock };
  let login: LoginUseCase;
  let verifyMfa: VerifyMfaUseCase;
  let refresh: RefreshSessionUseCase;

  beforeEach(() => {
    const config = {
      get: jest.fn((_key: string, defaultValue?: string) => defaultValue),
    } as unknown as ConfigService;
    const hashService = new HashService();

    users = new InMemoryUserRepository();
    users.add(acudiente);
    users.add(coordinadora);
    audit = { registrarIncidente: jest.fn().mockResolvedValue(undefined) };

    tokens = new TokenService(new JwtService({ secret: "test-jwt-secret" }));
    otp = new OtpMfaService(
      new InMemoryMfaRepository(),
      new AesEncryptionService(config),
      hashService,
    );
    const refreshTokens = new RefreshTokenService(
      new InMemoryTokenRepository(),
      hashService,
      audit,
    );
    const sessions = new SessionService(tokens, refreshTokens);
    const authService = new AuthService(users, new FakeHasher());

    login = new LoginUseCase(authService, sessions, users, audit);
    verifyMfa = new VerifyMfaUseCase(tokens, otp, sessions, users, audit);
    refresh = new RefreshSessionUseCase(refreshTokens, sessions, users);
  });

  describe("login", () => {
    it("debe entregar tokens directamente a un rol sin MFA", async () => {
      const result = await login.execute({
        email: acudiente.email,
        password: PASSWORD,
      });

      expect(result.requiresMfa).toBe(false);
      if (!result.requiresMfa) {
        const user = await tokens.verifyAccessToken(result.accessToken);
        expect(user.id_usuario).toBe(acudiente.id_usuario);
        expect(user.mfa_autenticado).toBe(false);
        expect(result.refreshToken).toBeDefined();
        expect(result.expiresIn).toBe(900);
      }
      expect(users.ultimoIngreso.has(acudiente.id_usuario)).toBe(true);
    });

    it("debe dar solo token provisional y desafío OTP a un rol directivo", async () => {
      const result = await login.execute({
        email: coordinadora.email,
        password: PASSWORD,
      });

      expect(result.requiresMfa).toBe(true);
      expect(result).not.toHaveProperty("accessToken");
      expect(result).not.toHaveProperty("refreshToken");
      if (result.requiresMfa) {
        expect(result.mfaChallenge).toEqual({ type: "TOTP", digits: 6 });
        expect(result.expiresIn).toBe(300);
        // El token provisional no sirve como Access Token
        await expect(tokens.verifyAccessToken(result.mfaToken)).rejects.toThrow(
          UnauthorizedException,
        );
      }
    });

    it("debe auditar y rechazar credenciales inválidas", async () => {
      await expect(
        login.execute({ email: acudiente.email, password: "incorrecta" }),
      ).rejects.toThrow(UnauthorizedException);

      expect(audit.registrarIncidente).toHaveBeenCalledWith(
        expect.objectContaining({ tipo_evento: "LOGIN_FAILED" }),
      );
    });
  });

  describe("verificación MFA", () => {
    async function desafio() {
      const result = await login.execute({
        email: coordinadora.email,
        password: PASSWORD,
      });
      if (!result.requiresMfa) {
        throw new Error("Se esperaba desafío MFA");
      }
      return result.mfaToken;
    }

    it("con el código OTP correcto emite el Access Token con MFA verificado", async () => {
      const mfaToken = await desafio();
      const { secretBase32 } = await otp.enroll(
        coordinadora.id_usuario,
        coordinadora.email,
      );
      const code = generateTotp(base32Decode(secretBase32));

      const session = await verifyMfa.execute(mfaToken, code);
      const user = await tokens.verifyAccessToken(session.accessToken);

      expect(user.mfa_autenticado).toBe(true);
      expect(user.roles).toContain("COORDINADORA_CONVIVENCIA");
      expect(session.refreshToken).toBeDefined();
      expect(audit.registrarIncidente).toHaveBeenCalledWith(
        expect.objectContaining({ tipo_evento: "MFA_VERIFY" }),
      );
    });

    it("con un código incorrecto rechaza y audita", async () => {
      const mfaToken = await desafio();
      const { secretBase32 } = await otp.enroll(
        coordinadora.id_usuario,
        coordinadora.email,
      );
      const valid = generateTotp(base32Decode(secretBase32));
      const wrong = valid === "000000" ? "000001" : "000000";

      await expect(verifyMfa.execute(mfaToken, wrong)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(audit.registrarIncidente).toHaveBeenCalledWith(
        expect.objectContaining({ tipo_evento: "MFA_VERIFY_FAILED" }),
      );
    });

    it("rechaza si el usuario no tiene MFA enrolado", async () => {
      const mfaToken = await desafio();

      await expect(verifyMfa.execute(mfaToken, "123456")).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("rechaza un Access Token usado como token provisional", async () => {
      const result = await login.execute({
        email: acudiente.email,
        password: PASSWORD,
      });
      if (result.requiresMfa) {
        throw new Error("No se esperaba desafío MFA");
      }

      await expect(
        verifyMfa.execute(result.accessToken, "123456"),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("rechaza el desafío si el usuario fue bloqueado entre pasos", async () => {
      const mfaToken = await desafio();
      users.setEstado(coordinadora.id_usuario, "BLOQUEADO");

      await expect(verifyMfa.execute(mfaToken, "123456")).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe("refresh", () => {
    async function sesionAcudiente() {
      const result = await login.execute({
        email: acudiente.email,
        password: PASSWORD,
      });
      if (result.requiresMfa) {
        throw new Error("No se esperaba desafío MFA");
      }
      return result;
    }

    it("debe rotar el refresh token y emitir un Access Token nuevo", async () => {
      const session = await sesionAcudiente();
      const renewed = await refresh.execute(session.refreshToken);

      expect(renewed.refreshToken).not.toBe(session.refreshToken);
      await expect(
        tokens.verifyAccessToken(renewed.accessToken),
      ).resolves.toMatchObject({ id_usuario: acudiente.id_usuario });
    });

    it("al reusar un refresh token consumido revoca toda la familia", async () => {
      const session = await sesionAcudiente();
      const renewed = await refresh.execute(session.refreshToken);

      await expect(refresh.execute(session.refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(refresh.execute(renewed.refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(audit.registrarIncidente).toHaveBeenCalledWith(
        expect.objectContaining({ tipo_evento: "REFRESH_TOKEN_REUSE_DETECTED" }),
      );
    });

    it("rechaza el refresh si el usuario fue desactivado", async () => {
      const session = await sesionAcudiente();
      users.setEstado(acudiente.id_usuario, "INACTIVO");

      await expect(refresh.execute(session.refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("mantiene mfa_autenticado en true al renovar a un rol directivo", async () => {
      const result = await login.execute({
        email: coordinadora.email,
        password: PASSWORD,
      });
      if (!result.requiresMfa) {
        throw new Error("Se esperaba desafío MFA");
      }
      const { secretBase32 } = await otp.enroll(
        coordinadora.id_usuario,
        coordinadora.email,
      );
      const session = await verifyMfa.execute(
        result.mfaToken,
        generateTotp(base32Decode(secretBase32)),
      );

      const renewed = await refresh.execute(session.refreshToken);
      const user = await tokens.verifyAccessToken(renewed.accessToken);

      expect(user.mfa_autenticado).toBe(true);
    });
  });
});
