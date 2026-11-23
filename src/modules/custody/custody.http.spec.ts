import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import * as request from "supertest";
import { CryptoModule } from "@common/crypto/crypto.module";
import { TripStateEnum } from "@common/enums/trip-state.enum";
import { AllExceptionsFilter } from "@common/filters/all-exceptions.filter";
import { AuthModule } from "../auth/auth.module";
import { TokenService } from "../auth/token.service";
import { TripsModule } from "../trips/trips.module";
import { CustodyModule } from "./custody.module";
import {
  CUSTODY_GENESIS_HASH,
  FsmCustodyState,
  TripDirection,
} from "./domain/custody.types";

describe("Custody & Trips HTTP (Issue #7: FSM, WORM SHA-256, RBAC y cierre de viaje)", () => {
  let app: INestApplication;
  let tokens: TokenService;

  const tripMorningId = "018e38d9-3f00-7200-a000-000000000501";
  const tripAfternoonId = "018e38d9-3f00-7200-a000-000000000502";
  const studentId = "018e38d9-3f00-7200-a000-000000000601";

  const makeToken = (roles: string[], mfa = true) =>
    tokens.signAccessToken(
      {
        id_usuario: "018e38d9-3f00-7200-a000-000000000001",
        email: "monitora@caminoseguro.co",
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
              CUSTODY_USE_POSTGRES: "false",
              CUSTODY_MORNING_JOB_ENABLED: "false",
            }),
          ],
        }),
        CryptoModule,
        AuthModule,
        CustodyModule,
        TripsModule,
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

  it("exige JWT (401) y restringe transiciones y verificación de integridad por RBAC (403)", async () => {
    await request(app.getHttpServer())
      .post("/custody/transitions")
      .send({})
      .expect(401);

    const parentAuth = `Bearer ${await makeToken(["ACUDIENTE"], false)}`;
    await request(app.getHttpServer())
      .post("/custody/transitions")
      .set("Authorization", parentAuth)
      .send({
        id_viaje: tripMorningId,
        id_estudiante: studentId,
        estado_destino: FsmCustodyState.EN_ESPERA_ABORDAJE,
        tipo_recorrido: TripDirection.MANANA,
      })
      .expect(403);

    await request(app.getHttpServer())
      .post("/custody/jobs/morning-init")
      .set("Authorization", parentAuth)
      .send({ fecha: "2026-11-23" })
      .expect(403);
  });

  it("Criterio de Aceptación #7 vía HTTP: rechaza con 422 NO_INICIADO -> ENTREGADO_ACUDIENTE sin mutar estado ni historial", async () => {
    const opsAuth = `Bearer ${await makeToken(["JEFE_OPERACIONES"], false)}`;
    const monitoraAuth = `Bearer ${await makeToken(["MONITORA"], false)}`;

    await request(app.getHttpServer())
      .post(`/custody/trips/${tripAfternoonId}/enroll`)
      .set("Authorization", opsAuth)
      .send({ id_estudiante: studentId })
      .expect(201);

    const rejected = await request(app.getHttpServer())
      .post("/custody/transitions")
      .set("Authorization", monitoraAuth)
      .send({
        id_viaje: tripAfternoonId,
        id_estudiante: studentId,
        estado_destino: FsmCustodyState.ENTREGADO_ACUDIENTE,
        tipo_recorrido: TripDirection.TARDE,
      })
      .expect(422);

    expect(rejected.body.message).toContain("NO_INICIADO");

    const state = await request(app.getHttpServer())
      .get(`/custody/trips/${tripAfternoonId}/students/${studentId}`)
      .set("Authorization", monitoraAuth)
      .expect(200);
    expect(state.body.estado_custodia).toBe(FsmCustodyState.NO_INICIADO);

    const history = await request(app.getHttpServer())
      .get(`/custody/trips/${tripAfternoonId}/history`)
      .set("Authorization", monitoraAuth)
      .expect(200);
    expect(history.body).toHaveLength(0);
  });

  it("flujo completo matutino + bloqueo de cierre de viaje con menor A_BORDO_VEHICULO (409) + verificación SHA-256 WORM", async () => {
    const opsAuth = `Bearer ${await makeToken(["JEFE_OPERACIONES"], false)}`;
    const monitoraAuth = `Bearer ${await makeToken(["MONITORA"], false)}`;

    await request(app.getHttpServer())
      .post(`/custody/trips/${tripMorningId}/enroll`)
      .set("Authorization", opsAuth)
      .send({ id_estudiante: studentId })
      .expect(201);

    const t1 = await request(app.getHttpServer())
      .post("/custody/transitions")
      .set("Authorization", monitoraAuth)
      .send({
        id_viaje: tripMorningId,
        id_estudiante: studentId,
        estado_destino: FsmCustodyState.EN_ESPERA_ABORDAJE,
        tipo_recorrido: TripDirection.MANANA,
        latitud: 4.8133,
        longitud: -75.6961,
      })
      .expect(201);
    expect(t1.body.history.hash_sha256_anterior).toBe(CUSTODY_GENESIS_HASH);

    const t2 = await request(app.getHttpServer())
      .post("/custody/transitions")
      .set("Authorization", monitoraAuth)
      .send({
        id_viaje: tripMorningId,
        id_estudiante: studentId,
        estado_destino: FsmCustodyState.A_BORDO_VEHICULO,
        tipo_recorrido: TripDirection.MANANA,
      })
      .expect(201);
    expect(t2.body.history.hash_sha256_anterior).toBe(
      t1.body.history.hash_sha256_actual,
    );

    // Intento de cerrar el viaje con estudiante A_BORDO_VEHICULO -> 409 Conflict
    await request(app.getHttpServer())
      .patch(`/trips/${tripMorningId}/finish`)
      .set("Authorization", monitoraAuth)
      .expect(409);

    // Desembarque en colegio -> cierra correctamente en FINALIZADO
    await request(app.getHttpServer())
      .post("/custody/transitions")
      .set("Authorization", monitoraAuth)
      .send({
        id_viaje: tripMorningId,
        id_estudiante: studentId,
        estado_destino: FsmCustodyState.EN_COLEGIO,
        tipo_recorrido: TripDirection.MANANA,
        latitud: 4.8143,
        longitud: -75.6946,
      })
      .expect(201);

    const finishRes = await request(app.getHttpServer())
      .patch(`/trips/${tripMorningId}/finish`)
      .set("Authorization", monitoraAuth)
      .expect(200);
    expect(finishRes.body.estado).toBe(TripStateEnum.FINALIZADO);

    const verify = await request(app.getHttpServer())
      .get("/custody/integrity/verify")
      .set("Authorization", opsAuth)
      .expect(200);
    expect(verify.body.cadena_integra).toBe(true);
    expect(verify.body.total_verificados).toBe(3);

    const morningInit = await request(app.getHttpServer())
      .post("/custody/jobs/morning-init")
      .set("Authorization", opsAuth)
      .send({ fecha: "2026-11-23" })
      .expect(200);
    expect(morningInit.body.fecha).toBe("2026-11-23");
  });

  it("rechaza con 400 payload malformado o coordenadas fuera de rango WGS84", async () => {
    const monitoraAuth = `Bearer ${await makeToken(["MONITORA"], false)}`;

    await request(app.getHttpServer())
      .post("/custody/transitions")
      .set("Authorization", monitoraAuth)
      .send({
        id_viaje: "not-a-uuid",
        id_estudiante: studentId,
        estado_destino: FsmCustodyState.EN_ESPERA_ABORDAJE,
        tipo_recorrido: TripDirection.MANANA,
      })
      .expect(400);

    await request(app.getHttpServer())
      .post("/custody/transitions")
      .set("Authorization", monitoraAuth)
      .send({
        id_viaje: tripMorningId,
        id_estudiante: studentId,
        estado_destino: FsmCustodyState.EN_ESPERA_ABORDAJE,
        tipo_recorrido: TripDirection.MANANA,
        latitud: 120,
        longitud: -75.6946,
      })
      .expect(400);
  });
});
