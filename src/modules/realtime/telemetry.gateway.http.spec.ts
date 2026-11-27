import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { io as createSocketClient, Socket } from "socket.io-client";
import * as request from "supertest";
import { CryptoModule } from "@common/crypto/crypto.module";
import { HashService } from "@common/crypto/hash.service";
import { IEventDispatcherPort } from "@common/ports/event-dispatcher.port";
import { TripStateEnum } from "@common/enums/trip-state.enum";
import { AllExceptionsFilter } from "@common/filters/all-exceptions.filter";
import { AttendanceModule } from "../attendance/attendance.module";
import { DeliveryValidationService } from "../attendance/delivery-validation.service";
import { ATTENDANCE_REPOSITORY } from "../attendance/domain/attendance-repository.port";
import {
  DisembarkResultCode,
  ReceptorType,
} from "../attendance/domain/disembark.types";
import { InMemoryAttendanceRepository } from "../attendance/infrastructure/in-memory-attendance.repository";
import { AuthModule } from "../auth/auth.module";
import { TokenService } from "../auth/token.service";
import { TELEMETRY_EVENT_DISPATCHER } from "../telemetry/domain/telemetry-ingest.port";
import { TELEMETRY_GPS_RECORDED_EVENT } from "../telemetry/domain/telemetry.types";
import { TelemetryModule } from "../telemetry/telemetry.module";
import { TripsModule } from "../trips/trips.module";
import {
  GPS_DISPATCH_LATENCY_BUDGET_MS,
  GPS_EMIT_THROTTLE_MS,
} from "./domain/realtime.constants";
import {
  GUARDIAN_LINK_REPOSITORY,
  REALTIME_CLOCK,
} from "./domain/realtime-ports";
import {
  GpsStreamFrame,
  StreamStatusPayload,
  SubscribeAck,
} from "./domain/realtime.types";
import { InMemoryGuardianLinkRepository } from "./infrastructure/in-memory-guardian-link.repository";
import { RealtimeModule } from "./realtime.module";
import { TelemetryGateway } from "./telemetry.gateway";

const makeUuid = (suffix: number) =>
  `018e38d9-3f00-7200-9400-${String(suffix).padStart(12, "0")}`;

const SCHOOL_ID = makeUuid(1);
const ROUTE_ID = makeUuid(2);
const STOP_3_COORDS = { latitud: 4.8133, longitud: -75.6961 };
const BOARDING_COORDS = { latitud: 4.8143, longitud: -75.6946 };
const GUARDIAN_DOC = "1088555444";

interface ConnectError extends Error {
  data?: { code?: string };
}

interface ClientProbe {
  readonly socket: Socket;
  readonly gps: GpsStreamFrame[];
  readonly status: StreamStatusPayload[];
  readonly expired: unknown[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  condition: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Condición no alcanzada a tiempo");
    }
    await sleep(10);
  }
}

describe("TelemetryGateway /telemetria — Socket.IO con salas segmentadas y aislamiento familiar (E2E Issue #14)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let tokens: TokenService;
  let attendance: InMemoryAttendanceRepository;
  let guardianLinks: InMemoryGuardianLinkRepository;
  let hashService: HashService;
  let validationService: DeliveryValidationService;
  let dispatcher: IEventDispatcherPort;
  let gateway: TelemetryGateway;
  let nowMs = Date.now();
  let gpsSeq = 0;
  const openSockets: Socket[] = [];

  const makeToken = (roles: string[], userId: string, mfa = false) =>
    tokens.signAccessToken(
      { id_usuario: userId, email: `${userId}@test.co`, roles },
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
              ATTENDANCE_USE_POSTGRES: "false",
              CUSTODY_USE_POSTGRES: "false",
              CUSTODY_MORNING_JOB_ENABLED: "false",
              MQTT_ENABLED: "false",
              TELEMETRY_USE_POSTGRES: "false",
              TELEMETRY_PARTITION_JOB_ENABLED: "false",
              REALTIME_USE_POSTGRES: "false",
              APP_BLIND_INDEX_HMAC_KEY: Buffer.from(
                "http-hmac-key-32-bytes-issue-14!",
              ).toString("base64"),
              APP_ENCRYPTION_MASTER_KEY: Buffer.from(
                "http-aes-key-32-bytes-issue-014!",
              ).toString("base64"),
            }),
          ],
        }),
        CryptoModule,
        AuthModule,
        AttendanceModule,
        TripsModule,
        TelemetryModule,
        RealtimeModule,
      ],
    })
      .overrideProvider(REALTIME_CLOCK)
      .useValue(() => nowMs)
      .compile();

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

    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${typeof address === "string" ? 0 : address.port}`;

    tokens = moduleRef.get(TokenService);
    attendance = moduleRef.get(ATTENDANCE_REPOSITORY);
    guardianLinks = moduleRef.get(GUARDIAN_LINK_REPOSITORY);
    hashService = moduleRef.get(HashService);
    validationService = moduleRef.get(DeliveryValidationService);
    dispatcher = moduleRef.get(TELEMETRY_EVENT_DISPATCHER);
    gateway = moduleRef.get(TelemetryGateway);
  });

  afterEach(() => {
    while (openSockets.length > 0) {
      openSockets.pop()?.disconnect();
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  function connect(auth: Record<string, unknown>): Promise<ClientProbe> {
    const socket = createSocketClient(`${baseUrl}/telemetria`, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      auth,
    });
    openSockets.push(socket);
    const probe: ClientProbe = { socket, gps: [], status: [], expired: [] };
    socket.on("trip:gps", (f: GpsStreamFrame) => probe.gps.push(f));
    socket.on("trip:stream_status", (s: StreamStatusPayload) =>
      probe.status.push(s),
    );
    socket.on("auth:expired", (e: unknown) => probe.expired.push(e));
    return new Promise((resolve, reject) => {
      socket.once("connect", () => resolve(probe));
      socket.once("connect_error", (err: ConnectError) => reject(err));
    });
  }

  const subscribe = (
    probe: ClientProbe,
    idViaje: unknown,
  ): Promise<SubscribeAck> =>
    probe.socket
      .timeout(2000)
      .emitWithAck("trip:subscribe", { id_viaje: idViaje });

  /** Publica un frame como lo haría la ingesta (#12) y avanza el reloj más allá del throttle. */
  async function publishGps(
    idViaje: string,
    extra: Record<string, unknown> = {},
  ) {
    nowMs += GPS_EMIT_THROTTLE_MS + 1;
    gpsSeq += 1;
    await dispatcher.publish(TELEMETRY_GPS_RECORDED_EVENT, {
      id_gps: `gps-${gpsSeq}`,
      id_viaje: idViaje,
      id_vehiculo: makeUuid(900),
      placa: "WKK123",
      latitud: STOP_3_COORDS.latitud,
      longitud: STOP_3_COORDS.longitud,
      velocidad_kmh: 25,
      rumbo_grados: 90,
      precision_metros: 4,
      precision_hdop: 0.9,
      odometro_km: 1200,
      bateria_respaldo_activa: false,
      fecha_hora: new Date(nowMs).toISOString(),
      partition_name: "registro_gps_2026_11",
      source: "MQTT",
      latency_ms: 3,
      ...extra,
    });
  }

  /** Espera a que el testigo (personal, siempre autorizado) reciba `n` frames. */
  async function settle(sentinel: ClientProbe, n: number) {
    await waitFor(() => sentinel.gps.length >= n);
    await sleep(80);
  }

  /** Inscribe y aborda vía HTTP real (#8) a los estudiantes, con su acudiente vinculado. */
  async function seedTrip(
    tripId: string,
    students: Array<{
      id: string;
      guardianUser: string;
      guardianId: string;
      board: boolean;
    }>,
  ) {
    const monitoraAuth = `Bearer ${await makeToken(["MONITORA"], makeUuid(800))}`;
    attendance.registerTrip({
      id_viaje: tripId,
      id_ruta: ROUTE_ID,
      estado: TripStateEnum.EN_CURSO,
      jornada: "TARDE",
      capacidad_nominal: 15,
      total_a_bordo: 0,
    });
    for (const [i, s] of students.entries()) {
      const qrRaw = `QR-RT14-${tripId.slice(-4)}-${i}`;
      attendance.registerStudent({
        id_estudiante: s.id,
        id_colegio: SCHOOL_ID,
        activo: true,
        qr_token_hash: hashService.sha256(qrRaw),
        id_acudiente_titular: s.guardianId,
      });
      attendance.registerRouteAssignment({
        id_estudiante: s.id,
        id_ruta: ROUTE_ID,
        ciclo_horario: "AMBOS",
        activa: true,
      });
      attendance.registerGuardianLink({
        id_acudiente: s.guardianId,
        id_estudiante: s.id,
        nombres: "Acudiente",
        apellidos: `Familia ${i}`,
        documento_blind_index:
          validationService.computeDocumentBlindIndex(GUARDIAN_DOC),
        parentesco: "MADRE",
        es_tutor_principal: true,
        orden_notificacion: 1,
      });
      guardianLinks.registerLink({
        id_usuario: s.guardianUser,
        id_acudiente: s.guardianId,
        id_estudiante: s.id,
      });
      if (s.board) {
        await boardStudent(tripId, qrRaw, monitoraAuth);
      }
    }
    return {
      monitoraAuth,
      qr: (i: number) => `QR-RT14-${tripId.slice(-4)}-${i}`,
    };
  }

  async function boardStudent(
    tripId: string,
    qrRaw: string,
    monitoraAuth: string,
  ) {
    await request(app.getHttpServer())
      .post("/asistencia/abordaje")
      .set("Authorization", monitoraAuth)
      .send({
        id_viaje: tripId,
        qr_token: qrRaw,
        coordenadas_gps: BOARDING_COORDS,
      })
      .expect(200);
  }

  describe("Handshake autenticado (ASVS V3.2)", () => {
    it.each([
      ["sin token", {}, "TOKEN_REQUIRED"],
      ["token inválido", { token: "x.y.z" }, "TOKEN_INVALID"],
    ])("rechaza la conexión %s", async (_label, auth, code) => {
      await expect(connect(auth)).rejects.toMatchObject({ data: { code } });
    });

    it("rechaza roles no autorizados y exige MFA donde aplica", async () => {
      await expect(
        connect({ token: await makeToken(["CONDUCTOR"], makeUuid(701)) }),
      ).rejects.toMatchObject({ data: { code: "ROLE_NOT_ALLOWED" } });
      await expect(
        connect({
          token: await makeToken(
            ["COORDINADORA_CONVIVENCIA"],
            makeUuid(702),
            false,
          ),
        }),
      ).rejects.toMatchObject({ data: { code: "MFA_REQUIRED" } });
    });
  });

  describe("Criterio de aceptación", () => {
    it("V-100: el hijo desciende en la parada 3 → cesa de inmediato el stream GPS a ESE acudiente", async () => {
      const tripV100 = makeUuid(100);
      const childA = makeUuid(1001);
      const childB = makeUuid(1002);
      const userA = makeUuid(3001);
      const userB = makeUuid(3002);
      const guardianA = makeUuid(4001);
      const guardianB = makeUuid(4002);
      await seedTrip(tripV100, [
        { id: childA, guardianUser: userA, guardianId: guardianA, board: true },
        { id: childB, guardianUser: userB, guardianId: guardianB, board: true },
      ]);
      const monitoraAuth = `Bearer ${await makeToken(["MONITORA"], makeUuid(801))}`;

      const parentA = await connect({
        token: await makeToken(["ACUDIENTE"], userA),
      });
      const parentB = await connect({
        token: await makeToken(["ACUDIENTE"], userB),
      });
      const staff = await connect({
        token: await makeToken(["MONITORA"], makeUuid(802)),
      });

      await expect(subscribe(parentA, tripV100)).resolves.toMatchObject({
        subscribed: true,
        room: `trip:${tripV100}`,
        transmitiendo: true,
        motivo: "ESTUDIANTE_A_BORDO",
        estudiantes: [
          { id_estudiante: childA, estado_custodia: "A_BORDO_VEHICULO" },
        ],
      });
      await subscribe(parentB, tripV100);
      await subscribe(staff, tripV100);

      // 1. Con el menor a bordo, ambos acudientes reciben las coordenadas.
      await publishGps(tripV100);
      await settle(staff, 1);
      expect(parentA.gps).toHaveLength(1);
      expect(parentB.gps).toHaveLength(1);
      expect(parentA.gps[0]).toEqual({
        id_viaje: tripV100,
        id_vehiculo: makeUuid(900),
        placa: "WKK123",
        latitud: STOP_3_COORDS.latitud,
        longitud: STOP_3_COORDS.longitud,
        velocidad_kmh: 25,
        rumbo_grados: 90,
        fecha_hora: expect.any(String),
      });

      // 2. Desembarque exitoso del hijo de A en la parada 3 (flujo HTTP real de #9).
      const disembark = await request(app.getHttpServer())
        .post("/asistencia/descenso")
        .set("Authorization", monitoraAuth)
        .send({
          id_viaje: tripV100,
          id_estudiante: childA,
          tipo_receptor: ReceptorType.ACUDIENTE,
          documento_receptor: GUARDIAN_DOC,
          coordenadas_gps: STOP_3_COORDS,
        })
        .expect(200);
      expect(disembark.body.codigo).toBe(DisembarkResultCode.DESCENSO_EXITOSO);

      // 3. El siguiente frame ya no llega a A; B (hijo aún a bordo) y el personal siguen recibiendo.
      await publishGps(tripV100);
      await settle(staff, 2);
      await publishGps(tripV100);
      await settle(staff, 3);

      expect(parentA.gps).toHaveLength(1);
      expect(parentB.gps).toHaveLength(3);
      expect(parentA.status).toEqual([
        expect.objectContaining({
          id_viaje: tripV100,
          suscrito: true,
          transmitiendo: false,
          motivo: "SIN_ESTUDIANTE_A_BORDO",
          estudiantes: [
            { id_estudiante: childA, estado_custodia: "ENTREGADO_ACUDIENTE" },
          ],
        }),
      ]);
      expect(parentB.status).toEqual([]);
    });
  });

  describe("Aislamiento familiar (RNF-02)", () => {
    it("no transmite antes de que el hijo suba y empieza al confirmar el abordaje", async () => {
      const trip = makeUuid(110);
      const child = makeUuid(1101);
      const user = makeUuid(3101);
      const { monitoraAuth, qr } = await seedTrip(trip, [
        {
          id: child,
          guardianUser: user,
          guardianId: makeUuid(4101),
          board: false,
        },
      ]);
      // El estudiante debe existir en la custodia del viaje: se inscribe con otro que sí aborda.
      const other = makeUuid(1102);
      await seedTripExtra(trip, other, monitoraAuth);

      const parent = await connect({
        token: await makeToken(["ACUDIENTE"], user),
      });
      const staff = await connect({
        token: await makeToken(["MONITORA"], makeUuid(803)),
      });
      await subscribe(staff, trip);

      // Sin inscripción en custodia todavía: el acudiente no tiene vínculo con el viaje.
      await expect(subscribe(parent, trip)).resolves.toMatchObject({
        subscribed: false,
        motivo: "SIN_VINCULO_CON_VIAJE",
      });

      await boardStudent(trip, qr(0), monitoraAuth);
      await expect(subscribe(parent, trip)).resolves.toMatchObject({
        subscribed: true,
        transmitiendo: true,
      });
      await publishGps(trip);
      await settle(staff, 1);
      expect(parent.gps).toHaveLength(1);
    });

    it("un acudiente sin hijos en el viaje no puede unirse a la sala ni recibir frames", async () => {
      const trip = makeUuid(120);
      await seedTrip(trip, [
        {
          id: makeUuid(1201),
          guardianUser: makeUuid(3201),
          guardianId: makeUuid(4201),
          board: true,
        },
      ]);
      const stranger = await connect({
        token: await makeToken(["ACUDIENTE"], makeUuid(3299)),
      });
      const staff = await connect({
        token: await makeToken(["MONITORA"], makeUuid(804)),
      });
      await subscribe(staff, trip);

      await expect(subscribe(stranger, trip)).resolves.toMatchObject({
        subscribed: false,
        room: null,
        motivo: "SIN_VINCULO_CON_VIAJE",
      });
      await publishGps(trip);
      await settle(staff, 1);
      expect(stranger.gps).toEqual([]);
    });

    it("valida el identificador de viaje y el payload de telemetría", async () => {
      const staff = await connect({
        token: await makeToken(["MONITORA"], makeUuid(805)),
      });
      await expect(subscribe(staff, "V-100")).resolves.toMatchObject({
        subscribed: false,
        motivo: "ID_VIAJE_INVALIDO",
      });
      const rejectedBefore = gateway.getMetrics().framesRejected;
      await dispatcher.publish(TELEMETRY_GPS_RECORDED_EVENT, {
        id_viaje: "x",
        latitud: 999,
      });
      await waitFor(
        () => gateway.getMetrics().framesRejected === rejectedBefore + 1,
      );
    });
  });

  describe("Throttle, sesión y reconexión", () => {
    it("emite como máximo 1 frame cada 2 s por cliente", async () => {
      const trip = makeUuid(130);
      await seedTrip(trip, [
        {
          id: makeUuid(1301),
          guardianUser: makeUuid(3301),
          guardianId: makeUuid(4301),
          board: true,
        },
      ]);
      const staff = await connect({
        token: await makeToken(["MONITORA"], makeUuid(806)),
      });
      await subscribe(staff, trip);

      await publishGps(trip);
      await settle(staff, 1);
      // Dos frames más dentro de la misma ventana de 2 s: se descartan.
      for (let i = 0; i < 2; i++) {
        gpsSeq += 1;
        nowMs += 500;
        await dispatcher.publish(TELEMETRY_GPS_RECORDED_EVENT, {
          id_viaje: trip,
          id_vehiculo: makeUuid(900),
          placa: "WKK123",
          latitud: 4.81,
          longitud: -75.69,
          velocidad_kmh: 20,
          rumbo_grados: 90,
          fecha_hora: new Date(nowMs).toISOString(),
        });
      }
      await sleep(150);
      expect(staff.gps).toHaveLength(1);
      await publishGps(trip);
      await settle(staff, 2);
      expect(staff.gps).toHaveLength(2);
    });

    it("cierra el socket cuando vence el Access Token (autorización por mensaje)", async () => {
      const trip = makeUuid(140);
      await seedTrip(trip, [
        {
          id: makeUuid(1401),
          guardianUser: makeUuid(3401),
          guardianId: makeUuid(4401),
          board: true,
        },
      ]);
      const parent = await connect({
        token: await makeToken(["ACUDIENTE"], makeUuid(3401)),
      });
      await subscribe(parent, trip);
      const disconnected = new Promise<void>((resolve) =>
        parent.socket.once("disconnect", () => resolve()),
      );

      const savedNow = nowMs;
      nowMs += 16 * 60 * 1000; // > 15 min de vigencia del Access Token (#3)
      await publishGps(trip);
      await disconnected;
      nowMs = savedNow;

      expect(parent.expired).toEqual([
        expect.objectContaining({ motivo: "TOKEN_EXPIRADO" }),
      ]);
      expect(parent.gps).toEqual([]);
    });

    it("re-suscribe automáticamente al reconectar con auth.id_viaje", async () => {
      const trip = makeUuid(150);
      const user = makeUuid(3501);
      await seedTrip(trip, [
        {
          id: makeUuid(1501),
          guardianUser: user,
          guardianId: makeUuid(4501),
          board: true,
        },
      ]);
      const parent = await connect({
        token: await makeToken(["ACUDIENTE"], user),
        id_viaje: trip,
      });
      await waitFor(() => parent.status.length === 1);
      expect(parent.status[0]).toMatchObject({
        id_viaje: trip,
        suscrito: true,
        transmitiendo: true,
      });

      // Caída de red simulada y reconexión del cliente móvil.
      parent.socket.disconnect();
      parent.socket.connect();
      await waitFor(() => parent.status.length === 2);
      expect(parent.status[1]).toMatchObject({
        suscrito: true,
        transmitiendo: true,
      });

      const staff = await connect({
        token: await makeToken(["MONITORA"], makeUuid(807)),
      });
      await subscribe(staff, trip);
      await publishGps(trip);
      await settle(staff, 1);
      expect(parent.gps).toHaveLength(1);
    });
  });

  describe("Heartbeat Engine.IO", () => {
    it("usa el ping/pong nativo de Socket.IO 4 (pingInterval 25 s, pingTimeout 20 s)", () => {
      const engineOpts = (
        gateway.server as unknown as {
          server: {
            engine: { opts: { pingInterval: number; pingTimeout: number } };
          };
        }
      ).server.engine.opts;
      expect(engineOpts.pingInterval).toBe(25_000);
      expect(engineOpts.pingTimeout).toBe(20_000);
    });
  });

  describe("DoD — latencia < 1 s", () => {
    it("entrega el frame al cliente en menos de 1 s desde la ingesta", async () => {
      const trip = makeUuid(160);
      const user = makeUuid(3601);
      await seedTrip(trip, [
        {
          id: makeUuid(1601),
          guardianUser: user,
          guardianId: makeUuid(4601),
          board: true,
        },
      ]);
      const parent = await connect({
        token: await makeToken(["ACUDIENTE"], user),
      });
      await subscribe(parent, trip);

      const latencies: number[] = [];
      for (let i = 0; i < 10; i++) {
        const sentAt = Date.now();
        const received = new Promise<void>((resolve) =>
          parent.socket.once("trip:gps", () => resolve()),
        );
        await publishGps(trip);
        await received;
        latencies.push(Date.now() - sentAt);
      }
      expect(Math.max(...latencies)).toBeLessThan(
        GPS_DISPATCH_LATENCY_BUDGET_MS,
      );
      expect(gateway.getMetrics().overBudgetDispatches).toBe(0);
    });
  });

  /** Inscribe y aborda un estudiante adicional (sin vínculo familiar del caso bajo prueba). */
  async function seedTripExtra(
    tripId: string,
    studentId: string,
    monitoraAuth: string,
  ) {
    const qrRaw = `QR-RT14-EXTRA-${tripId.slice(-4)}`;
    attendance.registerStudent({
      id_estudiante: studentId,
      id_colegio: SCHOOL_ID,
      activo: true,
      qr_token_hash: hashService.sha256(qrRaw),
      id_acudiente_titular: null,
    });
    attendance.registerRouteAssignment({
      id_estudiante: studentId,
      id_ruta: ROUTE_ID,
      ciclo_horario: "AMBOS",
      activa: true,
    });
    await boardStudent(tripId, qrRaw, monitoraAuth);
  }
});
