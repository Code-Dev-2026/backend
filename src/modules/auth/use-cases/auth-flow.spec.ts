import { UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { HashService } from "@common/crypto/hash.service";
import { MailerService } from "../../mailer/mailer.service";
import { AuthService } from "../auth.service";
import { IPasswordHasher } from "../domain/password-hasher.interface";
import { EmailOtpService } from "../email-otp.service";
import { InMemoryEmailOtpRepository } from "../infrastructure/in-memory-email-otp.repository";
import { InMemoryTokenRepository } from "../infrastructure/in-memory-token.repository";
import { InMemoryUserRepository } from "../infrastructure/in-memory-user.repository";
import { RefreshTokenService } from "../refresh-token.service";
import { SessionService } from "../session.service";
import { TokenService } from "../token.service";
import { LoginUseCase } from "./login.use-case";
import { RefreshSessionUseCase } from "./refresh-session.use-case";
import { VerifyOtpUseCase } from "./verify-otp.use-case";

class FakeHasher implements IPasswordHasher {
  async hash(plain: string) {
    return `fake:${plain}`;
  }
  async verify(plain: string, hash: string) {
    return hash === `fake:${plain}`;
  }
}

describe("Flujo de autenticación (login + OTP por correo + refresh)", () => {
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
  let tokens: TokenService;
  let mailer: { sendOtpCode: jest.Mock };
  let audit: { registrarIncidente: jest.Mock };
  let login: LoginUseCase;
  let verifyOtp: VerifyOtpUseCase;
  let refresh: RefreshSessionUseCase;

  beforeEach(() => {
    const hashService = new HashService();

    users = new InMemoryUserRepository();
    users.add(acudiente);
    users.add(coordinadora);
    audit = { registrarIncidente: jest.fn().mockResolvedValue(undefined) };
    mailer = { sendOtpCode: jest.fn().mockResolvedValue(undefined) };

    tokens = new TokenService(new JwtService({ secret: "test-jwt-secret" }));
    const emailOtp = new EmailOtpService(
      new InMemoryEmailOtpRepository(),
      hashService,
      mailer as unknown as MailerService,
    );
    const refreshTokens = new RefreshTokenService(
      new InMemoryTokenRepository(),
      hashService,
      audit,
    );
    const sessions = new SessionService(tokens, refreshTokens);
    const authService = new AuthService(users, new FakeHasher());

    login = new LoginUseCase(authService, sessions, emailOtp, audit);
    verifyOtp = new VerifyOtpUseCase(tokens, emailOtp, sessions, users, audit);
    refresh = new RefreshSessionUseCase(refreshTokens, sessions, users);
  });

  /** Último código enviado al correo indicado. */
  function codigoEnviadoA(email: string): string {
    const call = [...mailer.sendOtpCode.mock.calls]
      .reverse()
      .find(([to]) => to === email);
    if (!call) {
      throw new Error(`No se envió OTP a ${email}`);
    }
    return call[1] as string;
  }

  async function iniciarSesion(user: { email: string }) {
    const challenge = await login.execute({
      email: user.email,
      password: PASSWORD,
    });
    return verifyOtp.execute(challenge.mfaToken, codigoEnviadoA(user.email));
  }

  describe("POST /auth/login", () => {
    it.each([
      ["acudiente", acudiente],
      ["coordinadora", coordinadora],
    ])(
      "envía el OTP de 6 dígitos al correo de %s y no entrega tokens",
      async (_n, user) => {
        const result = await login.execute({
          email: user.email,
          password: PASSWORD,
        });

        expect(mailer.sendOtpCode).toHaveBeenCalledWith(
          user.email,
          expect.stringMatching(/^\d{6}$/),
          300,
        );
        expect(result.requiresMfa).toBe(true);
        expect(result.mfaChallenge.type).toBe("EMAIL_OTP");
        expect(result.mfaChallenge.digits).toBe(6);
        expect(result.mfaChallenge.destination).not.toBe(user.email);
        expect(result.expiresIn).toBe(300);
        expect(result).not.toHaveProperty("accessToken");
        expect(result).not.toHaveProperty("refreshToken");
        await expect(tokens.verifyAccessToken(result.mfaToken)).rejects.toThrow(
          UnauthorizedException,
        );
      },
    );

    it("rechaza credenciales inválidas, audita y no envía correo", async () => {
      await expect(
        login.execute({ email: acudiente.email, password: "incorrecta" }),
      ).rejects.toThrow(UnauthorizedException);

      expect(mailer.sendOtpCode).not.toHaveBeenCalled();
      expect(audit.registrarIncidente).toHaveBeenCalledWith(
        expect.objectContaining({ tipo_evento: "LOGIN_FAILED" }),
      );
    });
  });

  describe("POST /auth/verify-otp", () => {
    it("con el OTP correcto entrega Access Token (15 min) y Refresh Token", async () => {
      const session = await iniciarSesion(acudiente);
      const user = await tokens.verifyAccessToken(session.accessToken);
      const decoded = new JwtService().decode(session.accessToken) as {
        iat: number;
        exp: number;
      };

      expect(user.id_usuario).toBe(acudiente.id_usuario);
      expect(user.mfa_autenticado).toBe(true);
      expect(decoded.exp - decoded.iat).toBe(900);
      expect(session.refreshToken).toBeDefined();
      expect(session.expiresIn).toBe(900);
      expect(users.ultimoIngreso.has(acudiente.id_usuario)).toBe(true);
      expect(audit.registrarIncidente).toHaveBeenCalledWith(
        expect.objectContaining({ tipo_evento: "MFA_VERIFY" }),
      );
    });

    it("con un código incorrecto rechaza y audita", async () => {
      const { mfaToken } = await login.execute({
        email: acudiente.email,
        password: PASSWORD,
      });
      const valid = codigoEnviadoA(acudiente.email);
      const wrong = valid === "000000" ? "000001" : "000000";

      await expect(verifyOtp.execute(mfaToken, wrong)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(audit.registrarIncidente).toHaveBeenCalledWith(
        expect.objectContaining({ tipo_evento: "MFA_VERIFY_FAILED" }),
      );
    });

    it("no permite reusar el mismo OTP", async () => {
      const { mfaToken } = await login.execute({
        email: acudiente.email,
        password: PASSWORD,
      });
      const code = codigoEnviadoA(acudiente.email);

      await verifyOtp.execute(mfaToken, code);
      await expect(verifyOtp.execute(mfaToken, code)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("rechaza el OTP de otro usuario con el token provisional propio", async () => {
      const own = await login.execute({
        email: acudiente.email,
        password: PASSWORD,
      });
      await login.execute({ email: coordinadora.email, password: PASSWORD });

      await expect(
        verifyOtp.execute(own.mfaToken, codigoEnviadoA(coordinadora.email)),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("rechaza el token provisional de un login anterior", async () => {
      const first = await login.execute({
        email: acudiente.email,
        password: PASSWORD,
      });
      const firstCode = codigoEnviadoA(acudiente.email);
      await login.execute({ email: acudiente.email, password: PASSWORD });

      await expect(
        verifyOtp.execute(first.mfaToken, firstCode),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("rechaza el OTP pasados 300 segundos", async () => {
      const start = Date.now();
      const now = jest.spyOn(Date, "now").mockReturnValue(start);
      try {
        const { mfaToken } = await login.execute({
          email: acudiente.email,
          password: PASSWORD,
        });
        const code = codigoEnviadoA(acudiente.email);
        now.mockReturnValue(start + 300_000);

        await expect(verifyOtp.execute(mfaToken, code)).rejects.toThrow(
          UnauthorizedException,
        );
      } finally {
        now.mockRestore();
      }
    });

    it("rechaza un Access Token usado como token provisional", async () => {
      const session = await iniciarSesion(acudiente);

      await expect(
        verifyOtp.execute(session.accessToken, "123456"),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("rechaza el desafío si el usuario fue bloqueado entre pasos", async () => {
      const { mfaToken } = await login.execute({
        email: coordinadora.email,
        password: PASSWORD,
      });
      users.setEstado(coordinadora.id_usuario, "BLOQUEADO");

      await expect(
        verifyOtp.execute(mfaToken, codigoEnviadoA(coordinadora.email)),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe("refresh y sesiones", () => {
    it("rota el refresh token y emite un Access Token nuevo", async () => {
      const session = await iniciarSesion(acudiente);
      const renewed = await refresh.execute(session.refreshToken);

      expect(renewed.refreshToken).not.toBe(session.refreshToken);
      await expect(
        tokens.verifyAccessToken(renewed.accessToken),
      ).resolves.toMatchObject({
        id_usuario: acudiente.id_usuario,
        mfa_autenticado: true,
      });
    });

    it("al reusar un refresh token consumido revoca toda la familia", async () => {
      const session = await iniciarSesion(acudiente);
      const renewed = await refresh.execute(session.refreshToken);

      await expect(refresh.execute(session.refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(refresh.execute(renewed.refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(audit.registrarIncidente).toHaveBeenCalledWith(
        expect.objectContaining({
          tipo_evento: "REFRESH_TOKEN_REUSE_DETECTED",
        }),
      );
    });

    it("un login nuevo invalida las sesiones previas del usuario", async () => {
      const previous = await iniciarSesion(acudiente);
      const current = await iniciarSesion(acudiente);

      await expect(refresh.execute(previous.refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(
        refresh.execute(current.refreshToken),
      ).resolves.toBeDefined();
      // Una sesión cerrada no es un robo: no debe disparar la alarma de reuso
      expect(audit.registrarIncidente).not.toHaveBeenCalledWith(
        expect.objectContaining({
          tipo_evento: "REFRESH_TOKEN_REUSE_DETECTED",
        }),
      );
    });

    it("el login de un usuario no cierra la sesión de otro", async () => {
      const otra = await iniciarSesion(coordinadora);
      await iniciarSesion(acudiente);

      await expect(refresh.execute(otra.refreshToken)).resolves.toBeDefined();
    });

    it("rechaza el refresh si el usuario fue desactivado", async () => {
      const session = await iniciarSesion(acudiente);
      users.setEstado(acudiente.id_usuario, "INACTIVO");

      await expect(refresh.execute(session.refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
