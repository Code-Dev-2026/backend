import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import * as request from "supertest";
import { CryptoModule } from "@common/crypto/crypto.module";
import { HashService } from "@common/crypto/hash.service";
import { TripStateEnum } from "@common/enums/trip-state.enum";
import { AllExceptionsFilter } from "@common/filters/all-exceptions.filter";
import { AttendanceModule } from "../attendance/attendance.module";
import { DeliveryValidationService } from "../attendance/delivery-validation.service";
import { ATTENDANCE_REPOSITORY } from "../attendance/domain/attendance-repository.port";
import { ReceptorType } from "../attendance/domain/disembark.types";
import { InMemoryAttendanceRepository } from "../attendance/infrastructure/in-memory-attendance.repository";
import { AuthModule } from "../auth/auth.module";
import { TokenService } from "../auth/token.service";
import { CustodyService } from "../custody/custody.service";
import { TripsModule } from "../trips/trips.module";
import {
  DEVICE_REGISTRY,
  SYNC_OPERATION_REPOSITORY,
} from "./domain/offline-sync.ports";
import {
  InMemoryDeviceRegistry,
  InMemorySyncOperationRepository,
} from "./infrastructure/in-memory-offline-sync.repositories";
import { OfflineModule } from "./offline.module";

const makeUuid = (suffix: number) =>
  `018e38d9-3f00-7200-9600-${String(suffix).padStart(12, "0")}`;

const SCHOOL_ID = makeUuid(1);
const ROUTE_ID = makeUuid(2);
const MONITORA_USER = makeUuid(800);
const DEVICE = makeUuid(900);
const OTHER_DEVICE = makeUuid(901);
const GUARDIAN_DOC = "1088555444";
const BOARDING_COORDS = { latitud: 4.8143, longitud: -75.6946 };
const HOME_COORDS = { latitud: 4.8133, longitud: -75.6961 };

describe("POST /sync/offline — sincronización offline idempotente (Integración HTTP Issue #16)", () => {
  let app: INestApplication;
  let tokens: TokenService;
  let attendance: InMemoryAttendanceRepository;
  let syncOps: InMemorySyncOperationRepository;
  let devices: InMemoryDeviceRegistry;
  let custody: CustodyService;
  let hashService: HashService;
  let validationService: DeliveryValidationService;
  let monitoraAuth: string;

  const makeToken = (roles: string[], userId: string) =>
    tokens.signAccessToken(
      { id_usuario: userId, email: `${userId}@test.co`, roles },
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
              ATTENDANCE_USE_POSTGRES: "false",
              CUSTODY_USE_POSTGRES: "false",
              CUSTODY_MORNING_JOB_ENABLED: "false",
              OFFLINE_USE_POSTGRES: "false",
              NOTIFICATIONS_USE_POSTGRES: "false",
              APP_BLIND_INDEX_HMAC_KEY: Buffer.from(
                "http-hmac-key-32-bytes-issue-16!",
              ).toString("base64"),
              APP_ENCRYPTION_MASTER_KEY: Buffer.from(
                "http-aes-key-32-bytes-issue-016!",
              ).toString("base64"),
            }),
          ],
        }),
        CryptoModule,
        AuthModule,
        AttendanceModule,
        TripsModule,
        OfflineModule,
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
    attendance = moduleRef.get(ATTENDANCE_REPOSITORY);
    syncOps = moduleRef.get(SYNC_OPERATION_REPOSITORY);
    devices = moduleRef.get(DEVICE_REGISTRY);
    custody = moduleRef.get(CustodyService);
    hashService = moduleRef.get(HashService);
    validationService = moduleRef.get(DeliveryValidationService);

    devices.registerDevice({
      id_dispositivo: DEVICE,
      id_usuario: MONITORA_USER,
      activo: true,
    });
    devices.registerDevice({
      id_dispositivo: OTHER_DEVICE,
      id_usuario: makeUuid(801),
      activo: true,
    });
    monitoraAuth = `Bearer ${await makeToken(["MONITORA"], MONITORA_USER)}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  const qrOf = (trip: string, i: number) => `QR-OFF16-${trip.slice(-4)}-${i}`;

  function seedTrip(trip: string, students: string[]) {
    attendance.registerTrip({
      id_viaje: trip,
      id_ruta: ROUTE_ID,
      estado: TripStateEnum.EN_CURSO,
      jornada: "TARDE",
      capacidad_nominal: 15,
      total_a_bordo: 0,
    });
    students.forEach((id, i) => {
      const guardian = makeUuid(5000 + Number(id.slice(-4)));
      attendance.registerStudent({
        id_estudiante: id,
        id_colegio: SCHOOL_ID,
        activo: true,
        qr_token_hash: hashService.sha256(qrOf(trip, i)),
        id_acudiente_titular: guardian,
      });
      attendance.registerRouteAssignment({
        id_estudiante: id,
        id_ruta: ROUTE_ID,
        ciclo_horario: "AMBOS",
        activa: true,
      });
      attendance.registerGuardianLink({
        id_acudiente: guardian,
        id_estudiante: id,
        nombres: "Acudiente",
        apellidos: `Familia ${i}`,
        documento_blind_index:
          validationService.computeDocumentBlindIndex(GUARDIAN_DOC),
        parentesco: "MADRE",
        es_tutor_principal: true,
        orden_notificacion: 1,
      });
    });
  }

  const minutesAgo = (m: number) =>
    new Date(Date.now() - m * 60_000).toISOString();

  const boardingOp = (trip: string, i: number, key: string, ago: number) => ({
    idempotency_key: key,
    tipo: "ABORDAJE",
    fecha_cliente: minutesAgo(ago),
    datos: {
      id_viaje: trip,
      qr_token: qrOf(trip, i),
      coordenadas_gps: BOARDING_COORDS,
    },
  });

  const sync = (body: object, auth = monitoraAuth) =>
    request(app.getHttpServer())
      .post("/sync/offline")
      .set("Authorization", auth)
      .send(body);

  it("criterio de aceptación: 5 abordajes sin señal retransmitidos dos veces → éxito en ambas, sin duplicar inserciones", async () => {
    const trip = makeUuid(100);
    const students = [1, 2, 3, 4, 5].map((n) => makeUuid(1000 + n));
    seedTrip(trip, students);
    const batch = {
      id_dispositivo: DEVICE,
      operaciones: students.map((_, i) =>
        boardingOp(trip, i, `v100-scan-${i}`, 30 - i),
      ),
    };

    const first = await sync(batch).expect(200);
    const second = await sync(batch).expect(200);

    expect(first.body).toMatchObject({
      total: 5,
      procesadas: 5,
      duplicadas: 0,
      conflictos: 0,
    });
    expect(
      first.body.operaciones.every(
        (o: { codigo: string }) => o.codigo === "ABORDAJE_EXITOSO",
      ),
    ).toBe(true);
    expect(second.body).toMatchObject({
      total: 5,
      procesadas: 0,
      duplicadas: 5,
      conflictos: 0,
    });
    expect(
      second.body.operaciones.every(
        (o: { estado: string; duplicado: boolean }) =>
          o.estado === "PROCESADO" && o.duplicado,
      ),
    ).toBe(true);

    // Estado final único en las tablas de dominio.
    const occupancy = await attendance.getTripOccupancy(trip);
    expect(occupancy?.total_a_bordo).toBe(5);
    const states = await custody.listTripCustody(trip);
    expect(states).toHaveLength(5);
    expect(states.every((s) => s.estado_custodia === "A_BORDO_VEHICULO")).toBe(
      true,
    );
    // La retransmisión no llegó al caso de uso: ningún incidente ABORDAJE_PREVIO_EXISTE.
    expect(await attendance.listTripIncidents(trip)).toEqual([]);
    expect(
      syncOps.listAll().filter((s) => s.idempotency_key.startsWith("v100-")),
    ).toHaveLength(5);
  });

  it("ráfaga diferida desordenada: aplica abordajes antes que descensos según fecha_cliente", async () => {
    const trip = makeUuid(110);
    const students = [makeUuid(1101), makeUuid(1102)];
    seedTrip(trip, students);

    const res = await sync({
      id_dispositivo: DEVICE,
      operaciones: [
        {
          idempotency_key: "v110-desc-0",
          tipo: "DESCENSO",
          fecha_cliente: minutesAgo(5),
          datos: {
            id_viaje: trip,
            id_estudiante: students[0],
            tipo_receptor: ReceptorType.ACUDIENTE,
            documento_receptor: GUARDIAN_DOC,
            coordenadas_gps: HOME_COORDS,
          },
        },
        boardingOp(trip, 1, "v110-scan-1", 40),
        boardingOp(trip, 0, "v110-scan-0", 45),
      ],
    }).expect(200);

    expect(
      res.body.operaciones.map(
        (o: { idempotency_key: string }) => o.idempotency_key,
      ),
    ).toEqual(["v110-scan-0", "v110-scan-1", "v110-desc-0"]);
    expect(res.body).toMatchObject({ procesadas: 3, conflictos: 0 });
    expect(res.body.operaciones[2].codigo).toBe("DESCENSO_EXITOSO");
    expect((await attendance.getTripOccupancy(trip))?.total_a_bordo).toBe(1);

    // El documento del receptor no queda en claro en sync_operation.
    const stored = syncOps
      .listAll()
      .find((s) => s.idempotency_key === "v110-desc-0")!;
    expect(JSON.stringify(stored.payload_json)).not.toContain(GUARDIAN_DOC);
  });

  it("reporta CONFLICTO por regla de negocio sin abortar el lote (estudiante no a bordo)", async () => {
    const trip = makeUuid(120);
    const students = [makeUuid(1201), makeUuid(1202)];
    seedTrip(trip, students);

    const res = await sync({
      id_dispositivo: DEVICE,
      operaciones: [
        boardingOp(trip, 0, "v120-scan-0", 10),
        {
          idempotency_key: "v120-desc-1",
          tipo: "DESCENSO",
          fecha_cliente: minutesAgo(5),
          datos: {
            id_viaje: trip,
            id_estudiante: students[1],
            tipo_receptor: ReceptorType.ACUDIENTE,
            documento_receptor: GUARDIAN_DOC,
            coordenadas_gps: HOME_COORDS,
          },
        },
      ],
    }).expect(200);

    expect(res.body.operaciones[0]).toMatchObject({ estado: "PROCESADO" });
    expect(res.body.operaciones[1]).toMatchObject({ estado: "CONFLICTO" });
    expect(
      res.body.operaciones[1].resultado.http_status,
    ).toBeGreaterThanOrEqual(400);
  });

  it("descarta eventos con reloj desfasado > 24 h y payloads inválidos", async () => {
    const trip = makeUuid(130);
    seedTrip(trip, [makeUuid(1301)]);

    const res = await sync({
      id_dispositivo: DEVICE,
      operaciones: [
        {
          ...boardingOp(trip, 0, "v130-old-0", 0),
          fecha_cliente: minutesAgo(25 * 60),
        },
        {
          idempotency_key: "v130-bad-0",
          tipo: "ABORDAJE",
          fecha_cliente: minutesAgo(1),
          datos: {
            id_viaje: "no-uuid",
            qr_token: "x",
            coordenadas_gps: { latitud: 200, longitud: 0 },
          },
        },
      ],
    }).expect(200);

    const byKey = Object.fromEntries(
      res.body.operaciones.map((o: { idempotency_key: string }) => [
        o.idempotency_key,
        o,
      ]),
    );
    expect(byKey["v130-old-0"]).toMatchObject({
      estado: "DESCARTADO",
      codigo: "DESFASE_TEMPORAL",
    });
    expect(byKey["v130-bad-0"]).toMatchObject({
      estado: "DESCARTADO",
      codigo: "PAYLOAD_INVALIDO",
    });
    expect((await attendance.getTripOccupancy(trip))?.total_a_bordo).toBe(0);
  });

  describe("Seguridad (ASVS V11.1) y validación del esquema", () => {
    const valid = { id_dispositivo: DEVICE, operaciones: [] as unknown[] };

    it("exige JWT (401) y rol MONITORA (403)", async () => {
      await request(app.getHttpServer())
        .post("/sync/offline")
        .send(valid)
        .expect(401);
      await sync(
        valid,
        `Bearer ${await makeToken(["ACUDIENTE"], makeUuid(802))}`,
      ).expect(403);
    });

    it("rechaza el dispositivo de otra monitora (403 DISPOSITIVO_NO_AUTORIZADO)", async () => {
      const res = await sync({
        id_dispositivo: OTHER_DEVICE,
        operaciones: [boardingOp(makeUuid(140), 0, "v140-scan-0", 1)],
      }).expect(403);
      expect(JSON.stringify(res.body)).toContain("DISPOSITIVO_NO_AUTORIZADO");
    });

    it.each([
      ["lote vacío", { id_dispositivo: DEVICE, operaciones: [] }],
      [
        "id_dispositivo no UUID",
        { id_dispositivo: "tablet-1", operaciones: [{}] },
      ],
      [
        "idempotency_key inválida",
        {
          id_dispositivo: DEVICE,
          operaciones: [
            {
              idempotency_key: "a b",
              tipo: "ABORDAJE",
              fecha_cliente: minutesAgo(1),
              datos: {},
            },
          ],
        },
      ],
      [
        "tipo desconocido",
        {
          id_dispositivo: DEVICE,
          operaciones: [
            {
              idempotency_key: "key-00001",
              tipo: "BORRAR",
              fecha_cliente: minutesAgo(1),
              datos: {},
            },
          ],
        },
      ],
      [
        "fecha_cliente no ISO",
        {
          id_dispositivo: DEVICE,
          operaciones: [
            {
              idempotency_key: "key-00001",
              tipo: "ABORDAJE",
              fecha_cliente: "ayer",
              datos: {},
            },
          ],
        },
      ],
      [
        "más de 100 operaciones",
        {
          id_dispositivo: DEVICE,
          operaciones: Array.from({ length: 101 }, (_, i) => ({
            idempotency_key: `bulk-${String(i).padStart(4, "0")}`,
            tipo: "ABORDAJE",
            fecha_cliente: minutesAgo(1),
            datos: {},
          })),
        },
      ],
    ])("400 ante %s", async (_label, body) => {
      await sync(body).expect(400);
    });
  });
});
