import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import * as request from "supertest";
import { CryptoModule } from "@common/crypto/crypto.module";
import { RoleEnum } from "@common/enums/role.enum";
import { AllExceptionsFilter } from "@common/filters/all-exceptions.filter";
import { AuthModule } from "../auth/auth.module";
import { TokenService } from "../auth/token.service";
import { TELEMETRY_EVENT_DISPATCHER } from "./domain/telemetry-ingest.port";
import {
  formatGpsPartitionName,
  TELEMETRY_GPS_RECORDED_EVENT,
} from "./domain/telemetry.types";
import { InMemoryEventDispatcher } from "./infrastructure/in-memory-event-dispatcher";
import { TelemetryModule } from "./telemetry.module";

const makeUuid = (suffix: number) =>
  `018e38d9-3f00-7200-a900-${String(suffix).padStart(12, "0")}`;

describe("HTTP Fallback + RBAC — POST /telemetria/gps (Issue #12)", () => {
  let app: INestApplication;
  let tokens: TokenService;
  let dispatcher: InMemoryEventDispatcher;

  const makeToken = (roles: string[], userId: string) =>
    tokens.signAccessToken(
      {
        id_usuario: userId,
        email: `${userId}@caminoseguro.co`,
        roles,
      },
      false,
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
              MQTT_ENABLED: "false",
              TELEMETRY_USE_POSTGRES: "false",
              TELEMETRY_BATCH_SIZE: 10,
              TELEMETRY_BATCH_FLUSH_MS: 15,
              TELEMETRY_PARTITION_JOB_ENABLED: "false",
              APP_BLIND_INDEX_HMAC_KEY: Buffer.from(
                "http-hmac-key-32-bytes-issue-12!",
              ).toString("base64"),
              APP_ENCRYPTION_MASTER_KEY: Buffer.from(
                "http-aes-key-32-bytes-issue-012!",
              ).toString("base64"),
            }),
          ],
        }),
        CryptoModule,
        AuthModule,
        TelemetryModule,
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
    await app.listen(0);

    tokens = moduleRef.get(TokenService);
    dispatcher = moduleRef.get(TELEMETRY_EVENT_DISPATCHER);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dispatcher.clear();
  });

  it("retorna 401 sin token JWT y 403 para rol no operativo (ACUDIENTE)", async () => {
    const body = {
      placa: "WKK123",
      latitud: 4.8133,
      longitud: -75.6961,
      velocidad_kmh: 35,
      precision_metros: 8,
      rumbo_grados: 120,
      odometro_km: 14200.5,
      timestamp: new Date().toISOString(),
    };

    await request(app.getHttpServer())
      .post("/telemetria/gps")
      .send(body)
      .expect(401);

    const parentToken = await makeToken([RoleEnum.ACUDIENTE], makeUuid(1));
    await request(app.getHttpServer())
      .post("/telemetria/gps")
      .set("Authorization", `Bearer ${parentToken}`)
      .send(body)
      .expect(403);
  });

  it("ingiere paquete válido de WKK123 con rol CONDUCTOR, almacena en partición mensual y despacha evento en < 500 ms", async () => {
    const driverToken = await makeToken([RoleEnum.CONDUCTOR], makeUuid(2));
    const ts = new Date().toISOString();

    const res = await request(app.getHttpServer())
      .post("/telemetria/gps")
      .set("Authorization", `Bearer ${driverToken}`)
      .send({
        placa: "WKK123",
        latitud: 4.8133,
        longitud: -75.6961,
        velocidad_kmh: 42.3,
        precision_metros: 7.4,
        rumbo_grados: 185,
        odometro_km: 14201.2,
        timestamp: ts,
      })
      .expect(200);

    expect(res.body.status).toBe("STORED");
    expect(res.body.stored).toBe(true);
    expect(res.body.dispatched).toBe(true);
    expect(res.body.placa).toBe("WKK123");
    expect(res.body.partition_name).toBe(formatGpsPartitionName(new Date(ts)));
    expect(res.body.latency_ms).toBeLessThan(500);
    expect(dispatcher.getRecentEvents(TELEMETRY_GPS_RECORDED_EVENT)).toHaveLength(
      1,
    );

    // Reenvío duplicado del mismo timestamp retorna DUPLICATE_IGNORED
    const dupRes = await request(app.getHttpServer())
      .post("/telemetria/gps")
      .set("Authorization", `Bearer ${driverToken}`)
      .send({
        placa: "WKK123",
        latitud: 4.8133,
        longitud: -75.6961,
        velocidad_kmh: 42.3,
        precision_metros: 7.4,
        rumbo_grados: 185,
        odometro_km: 14201.2,
        timestamp: ts,
      })
      .expect(200);

    expect(dupRes.body.status).toBe("DUPLICATE_IGNORED");
    expect(dupRes.body.stored).toBe(false);
    expect(dupRes.body.dispatched).toBe(false);
  });

  it("descarta lectura con precisión > 30 m (DISCARDED_LOW_ACCURACY), retorna 400 si faltan datos/campos no permitidos y 404 si el vehículo no existe", async () => {
    const monitorToken = await makeToken([RoleEnum.MONITORA], makeUuid(3));

    const lowAcc = await request(app.getHttpServer())
      .post("/telemetria/gps")
      .set("Authorization", `Bearer ${monitorToken}`)
      .send({
        placa: "WKK123",
        latitud: 4.8133,
        longitud: -75.6961,
        velocidad_kmh: 20,
        precision_metros: 48.2,
        rumbo_grados: 90,
        odometro_km: 14202,
        timestamp: new Date().toISOString(),
      })
      .expect(200);

    expect(lowAcc.body.status).toBe("DISCARDED_LOW_ACCURACY");
    expect(lowAcc.body.stored).toBe(false);
    expect(dispatcher.getTotalPublished()).toBe(0);

    // Sin placa ni id_vehiculo -> 400
    await request(app.getHttpServer())
      .post("/telemetria/gps")
      .set("Authorization", `Bearer ${monitorToken}`)
      .send({
        latitud: 4.8133,
        longitud: -75.6961,
        velocidad_kmh: 20,
        precision_metros: 10,
        rumbo_grados: 90,
        odometro_km: 14202,
        timestamp: new Date().toISOString(),
      })
      .expect(400);

    // Campo no permitido -> 400 (forbidNonWhitelisted)
    await request(app.getHttpServer())
      .post("/telemetria/gps")
      .set("Authorization", `Bearer ${monitorToken}`)
      .send({
        placa: "WKK123",
        latitud: 4.8133,
        longitud: -75.6961,
        velocidad_kmh: 20,
        precision_metros: 10,
        rumbo_grados: 90,
        odometro_km: 14202,
        timestamp: new Date().toISOString(),
        campo_inyectado: "hack",
      })
      .expect(400);

    // Vehículo inexistente -> 404
    await request(app.getHttpServer())
      .post("/telemetria/gps")
      .set("Authorization", `Bearer ${monitorToken}`)
      .send({
        placa: "NOEX99",
        latitud: 4.8133,
        longitud: -75.6961,
        velocidad_kmh: 20,
        precision_metros: 10,
        rumbo_grados: 90,
        odometro_km: 14202,
        timestamp: new Date().toISOString(),
      })
      .expect(404);
  });
});
