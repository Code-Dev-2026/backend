import {
  Controller,
  Get,
  INestApplication,
  ValidationPipe,
} from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import * as request from "supertest";
import { CryptoModule } from "@common/crypto/crypto.module";
import { Roles } from "@common/decorators/roles.decorator";
import { MailerService } from "../mailer/mailer.service";
import { AuthModule } from "./auth.module";
import { USER_REPOSITORY } from "./domain/user.repository";
import { InMemoryUserRepository } from "./infrastructure/in-memory-user.repository";
import { UsersService } from "./users.service";

@Controller("zona-admin")
class ZonaAdminController {
  @Get()
  @Roles("ADMIN")
  entrar() {
    return { ok: true };
  }
}

/**
 * Prueba HTTP extremo a extremo del módulo con los guards globales reales:
 * login -> correo OTP -> verify-otp -> acceso por rol (200 / 403).
 */
describe("Auth HTTP (login, verify-otp y RBAC)", () => {
  const PASSWORD = "ContrasenaSegura2026";
  let app: INestApplication;
  const sendOtpCode = jest.fn().mockResolvedValue(undefined);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              JWT_SECRET: "secreto-propio-de-prueba-0123456789-abcdef",
              NODE_ENV: "test",
            }),
          ],
        }),
        CryptoModule,
        AuthModule,
      ],
      controllers: [ZonaAdminController],
    })
      .overrideProvider(MailerService)
      .useValue({ sendOtpCode })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    const users = moduleRef.get(UsersService);
    await users.create({
      email: "coordinacion@sanbenito.edu.co",
      password: PASSWORD,
      rol: "COORDINADORA_CONVIVENCIA",
    });
    await users.create({
      email: "conductor@transportes.co",
      password: PASSWORD,
      rol: "CONDUCTOR",
    });
    expect(moduleRef.get(USER_REPOSITORY)).toBeInstanceOf(
      InMemoryUserRepository,
    );
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  async function accessTokenDe(email: string): Promise<string> {
    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email, password: PASSWORD })
      .expect(200);

    expect(login.body).not.toHaveProperty("accessToken");
    const code = sendOtpCode.mock.calls.at(-1)[1];

    const verified = await request(app.getHttpServer())
      .post("/auth/verify-otp")
      .send({ mfaToken: login.body.mfaToken, code })
      .expect(200);

    expect(verified.body.refreshToken).toEqual(expect.any(String));
    return verified.body.accessToken;
  }

  it("POST /auth/login con contraseña errónea responde 401 y no envía correo", async () => {
    sendOtpCode.mockClear();
    await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: "conductor@transportes.co", password: "Incorrecta2026x" })
      .expect(401);
    expect(sendOtpCode).not.toHaveBeenCalled();
  }, 20_000);

  it("POST /auth/verify-otp con código inválido responde 401", async () => {
    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: "conductor@transportes.co", password: PASSWORD })
      .expect(200);
    const code = sendOtpCode.mock.calls.at(-1)[1] as string;
    const wrong = code === "000000" ? "000001" : "000000";

    await request(app.getHttpServer())
      .post("/auth/verify-otp")
      .send({ mfaToken: login.body.mfaToken, code: wrong })
      .expect(401);
  }, 20_000);

  it("sin token, una ruta protegida responde 401", async () => {
    await request(app.getHttpServer()).get("/zona-admin").expect(401);
  });

  it("@Roles('ADMIN') deja pasar a la coordinadora (200)", async () => {
    const token = await accessTokenDe("coordinacion@sanbenito.edu.co");

    await request(app.getHttpServer())
      .get("/zona-admin")
      .set("Authorization", `Bearer ${token}`)
      .expect(200, { ok: true });
  }, 20_000);

  it("@Roles('ADMIN') deniega al conductor con 403 Forbidden", async () => {
    const token = await accessTokenDe("conductor@transportes.co");

    await request(app.getHttpServer())
      .get("/zona-admin")
      .set("Authorization", `Bearer ${token}`)
      .expect(403);
  }, 20_000);
});
