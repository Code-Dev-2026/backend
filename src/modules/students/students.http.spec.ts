import {
  ConsoleLogger,
  INestApplication,
  ValidationPipe,
} from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import * as request from "supertest";
import { CryptoModule } from "@common/crypto/crypto.module";
import { AllExceptionsFilter } from "@common/filters/all-exceptions.filter";
import { LoggingInterceptor } from "@common/interceptors/logging.interceptor";
import { SanitizingLogger } from "@common/security/sanitizing-logger";
import { AuthModule } from "../auth/auth.module";
import { TokenService } from "../auth/token.service";
import { STUDENT_REPOSITORY } from "./domain/student.repository";
import { InMemoryStudentRepository } from "./infrastructure/in-memory-student.repository";
import { StudentsModule } from "./students.module";

/**
 * Prueba HTTP extremo a extremo con los guards globales reales
 * (JWT -> Roles -> MFA), el interceptor de logs y el logger sanitizador.
 */
describe("Students HTTP (expedientes restringidos y logs sin PII)", () => {
  let app: INestApplication;
  let tokens: TokenService;
  let repository: InMemoryStudentRepository;
  let logs: string[];

  const alta = {
    id_colegio: "018e38d9-3f00-7200-a000-0000000000c1",
    codigo_institucional: "EST-2026-089",
    nombre_completo: "Mateo Gómez Restrepo",
    documento_identidad: "1088123456",
    direccion: "Calle 10 # 5-20, Pereira",
    condiciones_medicas: "Asma leve",
    grado: "4A",
  };

  const token = (roles: string[], mfa = true) =>
    tokens.signAccessToken(
      {
        id_usuario: "018e38d9-3f00-7200-a000-000000000001",
        email: "usuario@colegio.co",
        roles,
      },
      mfa,
    );

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
        StudentsModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useLogger(new SanitizingLogger());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new LoggingInterceptor());
    await app.init();

    tokens = moduleRef.get(TokenService);
    repository = moduleRef.get(STUDENT_REPOSITORY);
  });

  beforeEach(() => {
    logs = [];
    jest
      .spyOn(ConsoleLogger.prototype as any, "printMessages")
      .mockImplementation((...args: unknown[]) => {
        logs.push(JSON.stringify(args[0]));
      });
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app?.close();
  });

  it("flujo completo: alta, consulta y búsqueda por documento (coordinadora)", async () => {
    const auth = `Bearer ${await token(["COORDINADORA_CONVIVENCIA"])}`;

    const created = await request(app.getHttpServer())
      .post("/students")
      .set("Authorization", auth)
      .send(alta)
      .expect(201);
    const id = created.body.id_estudiante;

    const stored = repository.dump()[0];
    expect(JSON.stringify(stored)).not.toContain("1088123456");
    expect(JSON.stringify(stored)).not.toContain("Asma");

    const expediente = await request(app.getHttpServer())
      .get(`/students/${id}`)
      .set("Authorization", auth)
      .expect(200);
    expect(expediente.headers["cache-control"]).toBe("no-store");
    expect(expediente.body.condiciones_medicas).toBe("Asma leve");

    const found = await request(app.getHttpServer())
      .post("/students/search")
      .set("Authorization", auth)
      .send({ documento: "1.088.123.456" })
      .expect(200);
    expect(found.body.id_estudiante).toBe(id);

    const list = await request(app.getHttpServer())
      .get("/students?offset=0&limit=10")
      .set("Authorization", auth)
      .expect(200);
    expect(list.body.items[0]).not.toHaveProperty("documento_identidad");
  });

  it("sin token responde 401", async () => {
    await request(app.getHttpServer()).get("/students").expect(401);
  });

  it.each(["ACUDIENTE", "MONITORA", "CONDUCTOR", "GERENCIA_TRANSPORTE"])(
    "rol %s recibe 403 Forbidden",
    async (rol) => {
      await request(app.getHttpServer())
        .post("/students/search")
        .set("Authorization", `Bearer ${await token([rol])}`)
        .send({ documento: "1088123456" })
        .expect(403);
    },
  );

  it("rectoría puede listar expedientes", async () => {
    await request(app.getHttpServer())
      .get("/students")
      .set("Authorization", `Bearer ${await token(["RECTORIA"])}`)
      .expect(200);
  });

  it("los logs de acceso y de error no contienen PII del estudiante", async () => {
    const auth = `Bearer ${await token(["COORDINADORA_CONVIVENCIA"])}`;

    // Búsqueda (log de acceso) y error de validación que repite el documento
    await request(app.getHttpServer())
      .post("/students/search")
      .set("Authorization", auth)
      .send({ documento: "5551234567" })
      .expect(404);
    await request(app.getHttpServer())
      .get("/students?documento=5551234567")
      .set("Authorization", auth)
      .expect(400);
    await request(app.getHttpServer())
      .post("/students")
      .set("Authorization", auth)
      .send({ ...alta, codigo_institucional: "X", id_colegio: "malo" })
      .expect(400);

    const all = logs.join("\n");
    expect(logs.length).toBeGreaterThan(0);
    expect(all).not.toContain("5551234567");
    expect(all).not.toContain("1088123456");
    expect(all).not.toMatch(/eyJ[\w-]+\.[\w-]+\./);
  });
});
