import { ConfigModule } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { CryptoModule } from "@common/crypto/crypto.module";
import { AuthController } from "./auth.controller";
import { AuthModule } from "./auth.module";

const SECRETO_PROPIO = "secreto-propio-de-prueba-0123456789-abcdef";
const SECRETO_POR_DEFECTO = "super_secret_jwt_key_camino_seguro_2026";

function compilar(config: Record<string, unknown>): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => config],
      }),
      CryptoModule,
      AuthModule,
    ],
  }).compile();
}

describe("AuthModule", () => {
  const envOriginal = { ...process.env };

  afterEach(() => {
    process.env = { ...envOriginal };
  });

  it("compila y expone el controller con un JWT_SECRET válido", async () => {
    delete process.env.JWT_SECRET;
    const module = await compilar({ JWT_SECRET: SECRETO_PROPIO });

    expect(module.get(AuthController)).toBeDefined();
    await module.close();
  });

  it("falla al arrancar si JWT_SECRET no está definido", async () => {
    delete process.env.JWT_SECRET;

    await expect(compilar({})).rejects.toThrow("JWT_SECRET no está definido");
  });

  it("en producción rechaza el secreto que viene por defecto", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.JWT_SECRET;

    await expect(compilar({ JWT_SECRET: SECRETO_POR_DEFECTO })).rejects.toThrow(
      "inseguro para producción",
    );
  });

  it("en producción rechaza un secreto de menos de 32 caracteres", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.JWT_SECRET;

    await expect(compilar({ JWT_SECRET: "corto" })).rejects.toThrow(
      "inseguro para producción",
    );
  });

  it("en producción acepta un secreto propio de 32 caracteres o más", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.JWT_SECRET;
    const module = await compilar({
      JWT_SECRET: SECRETO_PROPIO,
      SMTP_HOST: "smtp.example.com",
      APP_ENCRYPTION_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
      APP_BLIND_INDEX_HMAC_KEY: Buffer.alloc(32, 2).toString("base64"),
    });

    expect(module.get(AuthController)).toBeDefined();
    await module.close();
  });

  it("en producción falla al arrancar si no hay SMTP_HOST para enviar el OTP", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.JWT_SECRET;
    delete process.env.SMTP_HOST;

    await expect(compilar({ JWT_SECRET: SECRETO_PROPIO })).rejects.toThrow(
      "SMTP_HOST",
    );
  });
});
