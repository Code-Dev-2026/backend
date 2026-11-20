import { AuthController } from "./auth.controller";
import { LoginUseCase } from "./use-cases/login.use-case";
import { RefreshSessionUseCase } from "./use-cases/refresh-session.use-case";
import { VerifyMfaUseCase } from "./use-cases/verify-mfa.use-case";

describe("AuthController", () => {
  const loginUseCase = { execute: jest.fn() };
  const verifyMfaUseCase = { execute: jest.fn() };
  const refreshUseCase = { execute: jest.fn() };

  const controller = new AuthController(
    loginUseCase as unknown as LoginUseCase,
    verifyMfaUseCase as unknown as VerifyMfaUseCase,
    refreshUseCase as unknown as RefreshSessionUseCase,
  );

  beforeEach(() => jest.clearAllMocks());

  it("login delega en LoginUseCase", async () => {
    const dto = { email: "a@b.co", password: "ContrasenaSegura#2026" };
    loginUseCase.execute.mockResolvedValue({ requiresMfa: false });

    await expect(controller.login(dto)).resolves.toEqual({
      requiresMfa: false,
    });
    expect(loginUseCase.execute).toHaveBeenCalledWith(dto);
  });

  it("refresh delega en RefreshSessionUseCase con el token", async () => {
    refreshUseCase.execute.mockResolvedValue({ accessToken: "a" });

    await controller.refresh({ refreshToken: "rt" });

    expect(refreshUseCase.execute).toHaveBeenCalledWith("rt");
  });

  it("verifyMfa delega en VerifyMfaUseCase con token y código", async () => {
    verifyMfaUseCase.execute.mockResolvedValue({ accessToken: "a" });

    await controller.verifyMfa({ mfaToken: "mt", code: "123456" });

    expect(verifyMfaUseCase.execute).toHaveBeenCalledWith("mt", "123456");
  });
});
