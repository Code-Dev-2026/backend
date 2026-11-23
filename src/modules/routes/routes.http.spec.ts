import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import * as request from "supertest";
import { CryptoModule } from "@common/crypto/crypto.module";
import { AllExceptionsFilter } from "@common/filters/all-exceptions.filter";
import { AuthModule } from "../auth/auth.module";
import { TokenService } from "../auth/token.service";
import {
  SAN_BENITO_CENTER,
  SAN_BENITO_GEOFENCE_CODE,
  SAN_BENITO_SCHOOL_ID,
} from "./domain/geo.types";
import { AssignmentCycle, RouteShift, ZoneType } from "./domain/route.entity";
import { RoutesModule } from "./routes.module";

describe("Routes & Geo HTTP (Issue #6: GeoJSON, RBAC, OWASP ASVS V5.1 y FK compuesta)", () => {
  let app: INestApplication;
  let tokens: TokenService;

  const idEmpresa = "018e38d9-3f00-7200-a000-000000000003";
  const idEstudiante = "018e38d9-3f00-7200-a000-0000000000a1";

  const makeToken = (roles: string[], mfa = true) =>
    tokens.signAccessToken(
      {
        id_usuario: "018e38d9-3f00-7200-a000-000000000001",
        email: "operaciones@caminoseguro.co",
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
              GEO_USE_POSTGIS: "false",
            }),
          ],
        }),
        CryptoModule,
        AuthModule,
        RoutesModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    tokens = moduleRef.get(TokenService);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("rechaza peticiones sin JWT con 401 y bloquea escritura a ACUDIENTE con 403", async () => {
    await request(app.getHttpServer()).get("/routes").expect(401);

    const parentAuth = `Bearer ${await makeToken(["ACUDIENTE"], false)}`;
    await request(app.getHttpServer())
      .post("/routes")
      .set("Authorization", parentAuth)
      .send({
        id_colegio: SAN_BENITO_SCHOOL_ID,
        id_empresa: idEmpresa,
        codigo: "R-DENIED",
        nombre: "Ruta Bloqueada",
        jornada: RouteShift.MANANA,
        polilinea_oficial: {
          type: "LineString",
          coordinates: [
            [-75.6961, 4.8133],
            [-75.6946, 4.8143],
          ],
        },
        origen_nombre: "Origen",
        destino_nombre: "Destino",
      })
      .expect(403);

    // ACUDIENTE sí puede consultar la geocerca escolar
    const geofence = await request(app.getHttpServer())
      .get("/geo/zones/school-geofence")
      .set("Authorization", parentAuth)
      .expect(200);
    expect(geofence.body.codigo).toBe(SAN_BENITO_GEOFENCE_CODE);
  });

  it("flujo completo GeoJSON: rutas, paradas, proximidad y rechazo 422 por FK compuesta", async () => {
    const opsAuth = `Bearer ${await makeToken(["JEFE_OPERACIONES"], false)}`;

    const r1 = await request(app.getHttpServer())
      .post("/routes")
      .set("Authorization", opsAuth)
      .send({
        id_colegio: SAN_BENITO_SCHOOL_ID,
        id_empresa: idEmpresa,
        codigo: "R-01",
        nombre: "Ruta Pinares - San Benito",
        jornada: RouteShift.MANANA,
        polilinea_oficial: {
          type: "LineString",
          coordinates: [
            [-75.6961, 4.8133],
            [-75.6922, 4.8155],
            [-75.6946, 4.8143],
          ],
        },
        origen_nombre: "Parque Los Álamos",
        destino_nombre: "Colegio San Benito del Otún",
      })
      .expect(201);

    const r2 = await request(app.getHttpServer())
      .post("/routes")
      .set("Authorization", opsAuth)
      .send({
        id_colegio: SAN_BENITO_SCHOOL_ID,
        id_empresa: idEmpresa,
        codigo: "R-02",
        nombre: "Ruta Cerritos - San Benito",
        jornada: RouteShift.MANANA,
        polilinea_oficial: {
          type: "LineString",
          coordinates: [
            [-75.7395, 4.8127],
            [-75.6946, 4.8143],
          ],
        },
        origen_nombre: "Cerritos",
        destino_nombre: "Colegio San Benito del Otún",
      })
      .expect(201);

    const stopR1 = await request(app.getHttpServer())
      .post(`/routes/${r1.body.id_ruta}/stops`)
      .set("Authorization", opsAuth)
      .send({
        nombre: "Parque Los Álamos",
        orden_secuencia: 1,
        punto_geografico: { type: "Point", coordinates: [-75.6961, 4.8133] },
        horario_estimado: "06:25:00",
        radio_metros: 100,
      })
      .expect(201);

    const stopR2 = await request(app.getHttpServer())
      .post(`/routes/${r2.body.id_ruta}/stops`)
      .set("Authorization", opsAuth)
      .send({
        nombre: "Parada Cerritos",
        orden_secuencia: 1,
        punto_geografico: { type: "Point", coordinates: [-75.7395, 4.8127] },
        horario_estimado: "06:15:00",
        radio_metros: 120,
      })
      .expect(201);

    // Criterio de Aceptación: asignar estudiante a R-01 usando parada de R-02 -> 422
    await request(app.getHttpServer())
      .post(`/routes/${r1.body.id_ruta}/assignments`)
      .set("Authorization", opsAuth)
      .send({
        id_estudiante: idEstudiante,
        id_parada_subida: stopR2.body.id_parada,
        id_parada_bajada: stopR1.body.id_parada,
        ciclo_horario: AssignmentCycle.AMBOS,
      })
      .expect(422);

    // Asignación coherente con paradas de R-01 -> 201
    await request(app.getHttpServer())
      .post(`/routes/${r1.body.id_ruta}/assignments`)
      .set("Authorization", opsAuth)
      .send({
        id_estudiante: idEstudiante,
        id_parada_subida: stopR1.body.id_parada,
        id_parada_bajada: stopR1.body.id_parada,
        ciclo_horario: AssignmentCycle.AMBOS,
      })
      .expect(201);

    // Proximidad espacial dentro de 300m en Pereira
    const nearby = await request(app.getHttpServer())
      .get("/geo/proximity/stops")
      .query({ latitud: 4.8133, longitud: -75.6961, radio_metros: 300 })
      .set("Authorization", opsAuth)
      .expect(200);
    expect(nearby.body).toHaveLength(1);
    expect(nearby.body[0].id_parada).toBe(stopR1.body.id_parada);

    // Verificación de geocerca institucional del Colegio San Benito del Otún
    const inSchool = await request(app.getHttpServer())
      .post("/geo/proximity/school-geofence/check")
      .set("Authorization", opsAuth)
      .send({
        latitud: SAN_BENITO_CENTER.latitud,
        longitud: SAN_BENITO_CENTER.longitud,
      })
      .expect(200);
    expect(inSchool.body.dentro).toBe(true);
    expect(inSchool.body.zona.codigo).toBe(SAN_BENITO_GEOFENCE_CODE);
  });

  it("valida estrictamente rangos geográficos WGS84 con 400 (OWASP ASVS V5.1)", async () => {
    const opsAuth = `Bearer ${await makeToken(["JEFE_OPERACIONES"], false)}`;

    // Latitud inválida (> 90)
    await request(app.getHttpServer())
      .get("/geo/proximity/stops")
      .query({ latitud: 95, longitud: -75.6946, radio_metros: 500 })
      .set("Authorization", opsAuth)
      .expect(400);

    // Polígono GeoJSON no cerrado
    await request(app.getHttpServer())
      .post("/geo/zones")
      .set("Authorization", opsAuth)
      .send({
        nombre: "Zona Abierta Inválida",
        tipo_zona: ZoneType.SOMBRA_CELULAR,
        poligono: {
          type: "Polygon",
          coordinates: [
            [
              [-75.7, 4.81],
              [-75.69, 4.81],
              [-75.69, 4.82],
              [-75.7, 4.82], // Falta cerrar al primer vértice
            ],
          ],
        },
      })
      .expect(400);
  });
});
