import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import * as request from "supertest";
import { CryptoModule } from "@common/crypto/crypto.module";
import { AllExceptionsFilter } from "@common/filters/all-exceptions.filter";
import { AuthModule } from "../../auth/auth.module";
import { TokenService } from "../../auth/token.service";
import { STUDENT_REPOSITORY } from "../domain/student.repository";
import { InMemoryStudentRepository } from "../infrastructure/in-memory-student.repository";
import { StudentsModule } from "../students.module";
import { IMPORT_MAX_BYTES } from "./enrollment-import.service";

const COLEGIO = "018e38d9-3f00-7200-a000-000000000002";
const HEADER =
  "codigo_institucional,nombre_completo,documento_identidad,direccion,condiciones_medicas,grado";

function csv(rows: string[]): Buffer {
  return Buffer.from([HEADER, ...rows].join("\n"), "utf8");
}

describe("POST /students/import (HTTP multipart)", () => {
  let app: INestApplication;
  let tokens: TokenService;
  let repository: InMemoryStudentRepository;

  const auth = async (roles = ["COORDINADORA_CONVIVENCIA"]) =>
    `Bearer ${await tokens.signAccessToken(
      {
        id_usuario: "018e38d9-3f00-7200-a000-000000000001",
        email: "c@colegio.co",
        roles,
      },
      true,
    )}`;

  const upload = async (
    status: number,
    file: Buffer,
    name = "matriculas.csv",
    contentType = "text/csv",
    roles?: string[],
  ) =>
    request(app.getHttpServer())
      .post("/students/import")
      .set("Authorization", await auth(roles))
      .field("id_colegio", COLEGIO)
      .attach("file", file, { filename: name, contentType })
      .expect(status);

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

    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    tokens = moduleRef.get(TokenService);
    repository = moduleRef.get(STUDENT_REPOSITORY);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("importa el archivo (201) y luego rechaza el mismo archivo con 409", async () => {
    const file = csv([
      "EST-1,Mateo Gómez,1088123456,Calle 10,Asma,4A",
      "EST-2,Ana Ruiz,1088123457,Cra 5,,5B",
    ]);

    const first = await upload(201, file);
    expect(first.body).toMatchObject({
      estado: "COMPLETADA",
      total_filas: 2,
      creadas: 2,
      errores: [],
    });
    expect(first.headers["cache-control"]).toBe("no-store");

    const again = await upload(409, file, "otro-nombre.csv");
    expect(again.body.message).toContain("ya fue importado");
    expect(repository.dump()).toHaveLength(2);
  });

  it("con errores responde 422 con el detalle por fila y no guarda nada", async () => {
    const before = repository.dump().length;

    const res = await upload(
      422,
      csv([
        "EST-10,Luis Mora,1088000010,Calle 1,,3A",
        "EST-11,,1088000011,Calle 2,,3A",
      ]),
    );

    expect(res.body).toMatchObject({
      estado: "REVERTIDA",
      creadas: 0,
      total_errores: 1,
      errores: [{ fila: 3, campo: "nombre_completo" }],
    });
    expect(repository.dump()).toHaveLength(before);
  });

  it("rechaza tipos no permitidos con 415", async () => {
    await upload(415, Buffer.from("%PDF-1.4"), "m.pdf", "application/pdf");
  });

  it(`rechaza archivos de más de ${IMPORT_MAX_BYTES / 1024 / 1024} MB con 413`, async () => {
    await upload(413, Buffer.alloc(IMPORT_MAX_BYTES + 1, "a"));
  });

  it("sin archivo responde 400", async () => {
    await request(app.getHttpServer())
      .post("/students/import")
      .set("Authorization", await auth())
      .field("id_colegio", COLEGIO)
      .expect(400);
  });

  it("id_colegio inválido responde 400", async () => {
    await request(app.getHttpServer())
      .post("/students/import")
      .set("Authorization", await auth())
      .field("id_colegio", "no-es-uuid")
      .attach("file", csv(["EST-20,Ana,1088000020,Calle,,1A"]), {
        filename: "m.csv",
        contentType: "text/csv",
      })
      .expect(400);
  });

  it("un rol no administrativo recibe 403", async () => {
    await upload(
      403,
      csv(["EST-30,Ana,1088000030,Calle,,1A"]),
      "m.csv",
      "text/csv",
      ["MONITORA"],
    );
  });

  it("sin token responde 401", async () => {
    await request(app.getHttpServer()).post("/students/import").expect(401);
  });
});
