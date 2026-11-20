import { Controller, Get, INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import * as request from "supertest";
import { CryptoModule } from "../src/common/crypto/crypto.module";
import { Roles } from "../src/common/decorators/roles.decorator";
import { RoleEnum } from "../src/common/enums/role.enum";
import { AuthModule } from "../src/modules/auth/auth.module";
import { IPasswordHasher, PASSWORD_HASHER } from "../src/modules/auth/domain/password-hasher.interface";
import { USER_REPOSITORY } from "../src/modules/auth/domain/user.repository";
import { InMemoryUserRepository } from "../src/modules/auth/infrastructure/in-memory-user.repository";
import { base32Decode, generateTotp } from "../src/modules/auth/infrastructure/totp";
import { OtpMfaService } from "../src/modules/auth/otp-mfa.service";
import { TokenService } from "../src/modules/auth/token.service";

/** Rutas de sondeo SOLO para esta prueba: ejercitan los guards globales. */
@Controller("probe")
class ProbeController {
  @Get("coordinacion")
  @Roles(RoleEnum.COORDINADORA_CONVIVENCIA)
  coordinacion() {
    return { ok: true };
  }

  @Get("acudiente")
  @Roles(RoleEnum.ACUDIENTE)
  acudiente() {
    return { ok: true };
  }
}

describe("Auth (e2e)", () => {
  const PASSWORD = "ContrasenaSegura#2026";
  const acudiente = {
    id_usuario: "018e38d9-3f00-7200-a000-000000000002",
    email: "acudiente@correo.co",
    estado: "ACTIVO" as const,
    mfa_habilitado: false,
    roles: ["ACUDIENTE"],
  };
  const coordinadora = {
    id_usuario: "018e38d9-3f00-7200-a000-000000000001",
    email: "coordinacion@sanbenito.edu.co",
    estado: "ACTIVO" as const,
    mfa_habilitado: true,
    roles: ["COORDINADORA_CONVIVENCIA"],
  };

  let app: INestApplication;
  let jwt: JwtService;
  let tokens: TokenService;
  let totpSecret: Buffer;

  const http = () => request(app.getHttpServer());

  const loginAcudiente = () =>
    http().post("/auth/login").send({ email: acudiente.email, password: PASSWORD });

  const loginCoordinadora = () =>
    http()
      .post("/auth/login")
      .send({ email: coordinadora.email, password: PASSWORD });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              JWT_SECRET: "e2e-secreto-de-prueba-0123456789abcdef",
              NODE_ENV: "test",
            }),
          ],
        }),
        CryptoModule,
        AuthModule,
      ],
      controllers: [ProbeController],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    jwt = app.get(JwtService);
    tokens = app.get(TokenService);

    const users = app.get<InMemoryUserRepository>(USER_REPOSITORY);
    const hasher = app.get<IPasswordHasher>(PASSWORD_HASHER);
    const password_hash = await hasher.hash(PASSWORD);
    users.add({ ...acudiente, password_hash });
    users.add({ ...coordinadora, password_hash });

    const enrollment = await app
      .get(OtpMfaService)
      .enroll(coordinadora.id_usuario, coordinadora.email);
    totpSecret = base32Decode(enrollment.secretBase32);
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  describe("POST /auth/login", () => {
    it("un rol sin MFA recibe Access Token y Refresh Token", async () => {
      const res = await loginAcudiente().expect(200);

      expect(res.body.requiresMfa).toBe(false);
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.refreshToken).toEqual(expect.any(String));
      expect(res.body.expiresIn).toBe(900);
    });

    it("un rol directivo recibe solo token provisional y desafío OTP", async () => {
      const res = await loginCoordinadora().expect(200);

      expect(res.body.requiresMfa).toBe(true);
      expect(res.body.mfaToken).toEqual(expect.any(String));
      expect(res.body.mfaChallenge).toEqual({ type: "TOTP", digits: 6 });
      expect(res.body.accessToken).toBeUndefined();
      expect(res.body.refreshToken).toBeUndefined();
    });

    it("rechaza una contraseña incorrecta con 401", async () => {
      await http()
        .post("/auth/login")
        .send({ email: acudiente.email, password: "IncorrectaXYZ#1" })
        .expect(401);
    });

    it("rechaza un cuerpo inválido con 400", async () => {
      await http()
        .post("/auth/login")
        .send({ email: "no-es-un-correo" })
        .expect(400);
    });
  });

  describe("POST /auth/mfa/verify", () => {
    it("con el código OTP correcto emite el Access Token y abre rutas del rol", async () => {
      const login = await loginCoordinadora().expect(200);

      const verify = await http()
        .post("/auth/mfa/verify")
        .send({
          mfaToken: login.body.mfaToken,
          code: generateTotp(totpSecret),
        })
        .expect(200);

      expect(verify.body.accessToken).toEqual(expect.any(String));
      expect(verify.body.refreshToken).toEqual(expect.any(String));

      await http()
        .get("/probe/coordinacion")
        .set("Authorization", `Bearer ${verify.body.accessToken}`)
        .expect(200);
    });

    it("con un código OTP inválido responde 401", async () => {
      const login = await loginCoordinadora().expect(200);
      const valid = generateTotp(totpSecret);
      const wrong = valid === "000000" ? "000001" : "000000";

      await http()
        .post("/auth/mfa/verify")
        .send({ mfaToken: login.body.mfaToken, code: wrong })
        .expect(401);
    });

    it("con un token provisional inválido responde 401", async () => {
      await http()
        .post("/auth/mfa/verify")
        .send({ mfaToken: "no.es.jwt", code: "123456" })
        .expect(401);
    });
  });

  describe("endpoints protegidos (guards globales)", () => {
    it("sin token responde 401", async () => {
      await http().get("/probe/acudiente").expect(401);
    });

    it("con un token expirado responde 401", async () => {
      const expired = await jwt.signAsync(
        {
          sub: acudiente.id_usuario,
          email: acudiente.email,
          roles: acudiente.roles,
          mfa: false,
          typ: "access",
        },
        { expiresIn: "-10s" },
      );

      await http()
        .get("/probe/acudiente")
        .set("Authorization", `Bearer ${expired}`)
        .expect(401);
    });

    it("con un token manipulado responde 401", async () => {
      const login = await loginAcudiente().expect(200);
      const [header, , signature] = login.body.accessToken.split(".");
      const forged = Buffer.from(
        JSON.stringify({
          sub: acudiente.id_usuario,
          email: acudiente.email,
          roles: ["COORDINADORA_CONVIVENCIA"],
          mfa: true,
          typ: "access",
        }),
      ).toString("base64url");

      await http()
        .get("/probe/coordinacion")
        .set("Authorization", `Bearer ${header}.${forged}.${signature}`)
        .expect(401);
    });

    it("el token provisional MFA no sirve como Access Token", async () => {
      const login = await loginCoordinadora().expect(200);

      await http()
        .get("/probe/coordinacion")
        .set("Authorization", `Bearer ${login.body.mfaToken}`)
        .expect(401);
    });

    it("RBAC: un rol sin permiso recibe 403", async () => {
      const login = await loginAcudiente().expect(200);

      await http()
        .get("/probe/coordinacion")
        .set("Authorization", `Bearer ${login.body.accessToken}`)
        .expect(403);
    });

    it("RBAC: un rol con permiso recibe 200", async () => {
      const login = await loginAcudiente().expect(200);

      await http()
        .get("/probe/acudiente")
        .set("Authorization", `Bearer ${login.body.accessToken}`)
        .expect(200);
    });

    it("un rol directivo sin MFA verificado recibe 401", async () => {
      const noMfa = await tokens.signAccessToken(
        {
          id_usuario: coordinadora.id_usuario,
          email: coordinadora.email,
          roles: coordinadora.roles,
        },
        false,
      );

      await http()
        .get("/probe/coordinacion")
        .set("Authorization", `Bearer ${noMfa}`)
        .expect(401);
    });
  });

  describe("POST /auth/refresh", () => {
    it("rota el refresh token y revoca la familia si se reutiliza", async () => {
      const login = await loginAcudiente().expect(200);
      const first = login.body.refreshToken;

      const renewed = await http()
        .post("/auth/refresh")
        .send({ refreshToken: first })
        .expect(200);
      expect(renewed.body.refreshToken).not.toBe(first);
      expect(renewed.body.accessToken).toEqual(expect.any(String));

      // Reusar el token ya consumido = posible robo
      await http().post("/auth/refresh").send({ refreshToken: first }).expect(401);

      // La familia entera quedó revocada, incluido el token legítimo
      await http()
        .post("/auth/refresh")
        .send({ refreshToken: renewed.body.refreshToken })
        .expect(401);
    });

    it("rechaza un refresh token desconocido con 401", async () => {
      await http()
        .post("/auth/refresh")
        .send({ refreshToken: "token-inventado" })
        .expect(401);
    });

    it("rechaza un cuerpo vacío con 400", async () => {
      await http().post("/auth/refresh").send({}).expect(400);
    });
  });
});
