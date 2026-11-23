import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { LoginDto } from "./login.dto";
import { VerifyOtpDto } from "./verify-otp.dto";
import { RefreshTokenDto } from "./refresh-token.dto";

async function errores<T extends object>(
  clase: new () => T,
  datos: Record<string, unknown>,
): Promise<string[]> {
  const result = await validate(plainToInstance(clase, datos));
  return result.map((e) => e.property);
}

describe("DTOs de auth", () => {
  describe("LoginDto", () => {
    it("acepta correo y contraseña válidos", async () => {
      await expect(
        errores(LoginDto, {
          email: "coordinacion@sanbenito.edu.co",
          password: "ContrasenaSegura#2026",
        }),
      ).resolves.toEqual([]);
    });

    it("rechaza un correo con formato inválido", async () => {
      await expect(
        errores(LoginDto, { email: "no-es-correo", password: "12345678" }),
      ).resolves.toContain("email");
    });

    it("rechaza una contraseña de menos de 8 caracteres", async () => {
      await expect(
        errores(LoginDto, { email: "a@b.co", password: "corta" }),
      ).resolves.toContain("password");
    });

    it("rechaza campos faltantes", async () => {
      await expect(errores(LoginDto, {})).resolves.toEqual(
        expect.arrayContaining(["email", "password"]),
      );
    });
  });

  describe("VerifyOtpDto", () => {
    it("acepta un código OTP de 6 dígitos", async () => {
      await expect(
        errores(VerifyOtpDto, { mfaToken: "abc.def.ghi", code: "123456" }),
      ).resolves.toEqual([]);
    });

    it("rechaza códigos que no son exactamente 6 dígitos", async () => {
      for (const code of ["12", "1234567", "abcdef", "12 345", ""]) {
        await expect(
          errores(VerifyOtpDto, { mfaToken: "abc.def.ghi", code }),
        ).resolves.toContain("code");
      }
    });

    it("rechaza un token provisional vacío", async () => {
      await expect(
        errores(VerifyOtpDto, { mfaToken: "", code: "123456" }),
      ).resolves.toContain("mfaToken");
    });
  });

  describe("RefreshTokenDto", () => {
    it("acepta un refresh token", async () => {
      await expect(
        errores(RefreshTokenDto, { refreshToken: "token-valido" }),
      ).resolves.toEqual([]);
    });

    it("rechaza un refresh token vacío, faltante o demasiado largo", async () => {
      await expect(
        errores(RefreshTokenDto, { refreshToken: "" }),
      ).resolves.toContain("refreshToken");
      await expect(errores(RefreshTokenDto, {})).resolves.toContain(
        "refreshToken",
      );
      await expect(
        errores(RefreshTokenDto, { refreshToken: "x".repeat(513) }),
      ).resolves.toContain("refreshToken");
    });
  });
});
