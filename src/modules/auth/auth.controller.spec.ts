import { AuthController } from "./auth.controller";
import { LoginUseCase } from "./use-cases/login.use-case";
import { RefreshSessionUseCase } from "./use-cases/refresh-session.use-case";
import { VerifyOtpUseCase } from "./use-cases/verify-otp.use-case";

describe("AuthController", () => {
  const loginUseCase = { execute: jest.fn() };
  const verifyOtpUseCase = { execute: jest.fn() };
  const refreshUseCase = { execute: jest.fn() };

  const controller = new AuthController(
    loginUseCase as unknown as LoginUseCase,
    verifyOtpUseCase as unknown as VerifyOtpUseCase,
    refreshUseCase as unknown as RefreshSessionUseCase,
  );

  beforeEach(() => jest.clearAllMocks());

  it("login delega en LoginUseCase", async () => {
    const dto = { email: "a@b.co", password: "ContrasenaSegura#2026" };
    loginUseCase.execute.mockResolvedValue({ requiresMfa: true });

    await expect(controller.login(dto)).resolves.toEqual({
      requiresMfa: true,
    });
    expect(loginUseCase.execute).toHaveBeenCalledWith(dto);
  });

  it("verifyOtp delega en VerifyOtpUseCase con token y código", async () => {
    verifyOtpUseCase.execute.mockResolvedValue({ accessToken: "a" });

    await controller.verifyOtp({ mfaToken: "mt", code: "123456" });

    expect(verifyOtpUseCase.execute).toHaveBeenCalledWith("mt", "123456");
  });

  it("refresh delega en RefreshSessionUseCase con el token", async () => {
    refreshUseCase.execute.mockResolvedValue({ accessToken: "a" });

    await controller.refresh({ refreshToken: "rt" });

    expect(refreshUseCase.execute).toHaveBeenCalledWith("rt");
  });

  it("expone POST /auth/verify-otp", () => {
    const path = Reflect.getMetadata(
      "path",
      AuthController.prototype.verifyOtp,
    );
    expect(path).toBe("verify-otp");
  });
});
