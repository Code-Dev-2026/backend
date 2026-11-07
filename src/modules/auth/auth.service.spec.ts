import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { AuthService } from "./auth.service";
import { HashService } from "@common/crypto/hash.service";
import { UnauthorizedException } from "@nestjs/common";

describe("AuthService (Sprint 1)", () => {
  let service: AuthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        HashService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue("test-jwt-secret"),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it("debe autenticar credenciales válidas y emitir tokens", async () => {
    const result = await service.login({
      email: "coordinacion@sanbenito.edu.co",
      password: "password123",
    });

    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();
    expect(result.user.roles).toContain("COORDINADORA_CONVIVENCIA");
  });

  it("debe arrojar UnauthorizedException si faltan credenciales", async () => {
    await expect(service.login({ email: "", password: "" })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("debe verificar código TOTP MFA de 6 dígitos", async () => {
    const result = await service.verifyMfa("user-1", "123456");
    expect(result.mfaVerified).toBe(true);
  });

  it("debe fallar si el código TOTP no tiene 6 dígitos", async () => {
    await expect(service.verifyMfa("user-1", "123")).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
