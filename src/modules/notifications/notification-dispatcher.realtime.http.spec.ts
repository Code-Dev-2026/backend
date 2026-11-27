import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { io as createSocketClient, Socket } from "socket.io-client";
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
import {
  FsmCustodyState,
  TripDirection,
} from "../custody/domain/custody.types";
import { GUARDIAN_LINK_REPOSITORY } from "../realtime/domain/realtime-ports";
import { InMemoryGuardianLinkRepository } from "../realtime/infrastructure/in-memory-guardian-link.repository";
import { RealtimeModule } from "../realtime/realtime.module";
import { TelemetryModule } from "../telemetry/telemetry.module";
import { TripsModule } from "../trips/trips.module";
import {
  NOTIFICATION_DISPATCH_OPTIONS,
  NOTIFICATION_LATENCY_BUDGET_MS,
  NOTIFICATION_RECIPIENT_DIRECTORY,
  NOTIFICATION_REPOSITORY,
} from "./domain/notification-dispatch.ports";
import { OutboundNotification } from "./domain/notification-dispatch.types";
import { InMemoryNotificationRepository } from "./infrastructure/in-memory-notification.repository";
import { InMemoryNotificationRecipientDirectory } from "./infrastructure/notification-recipient.directory";
import { NotificationDispatcherService } from "./notification-dispatcher.service";

const makeUuid = (suffix: number) =>
  `018e38d9-3f00-7200-9500-${String(suffix).padStart(12, "0")}`;

const SCHOOL_ID = makeUuid(1);
const ROUTE_ID = makeUuid(2);
const HOME_COORDS = { latitud: 4.8133, longitud: -75.6961 };
const BOARDING_COORDS = { latitud: 4.8143, longitud: -75.6946 };
const GUARDIAN_DOC = "1088555444";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  condition: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Condición no alcanzada a tiempo");
    }
    await sleep(10);
  }
}

interface Family {
  readonly user: string;
  readonly guardian: string;
  readonly student: string;
}

interface Inbox {
  readonly socket: Socket;
  readonly items: OutboundNotification[];
}

describe("NotificationDispatcherService + Socket.IO sala familiar (Integración E2E Issue #15)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let tokens: TokenService;
  let attendance: InMemoryAttendanceRepository;
  let guardianLinks: InMemoryGuardianLinkRepository;
  let directory: InMemoryNotificationRecipientDirectory;
  let notifications: InMemoryNotificationRepository;
  let dispatcher: NotificationDispatcherService;
  let custody: CustodyService;
  let hashService: HashService;
  let validationService: DeliveryValidationService;
  let monitoraAuth: string;
  const sockets: Socket[] = [];

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
              NOTIFICATIONS_USE_POSTGRES: "false",
              APP_BLIND_INDEX_HMAC_KEY: Buffer.from(
                "http-hmac-key-32-bytes-issue-15!",
              ).toString("base64"),
              APP_ENCRYPTION_MASTER_KEY: Buffer.from(
                "http-aes-key-32-bytes-issue-015!",
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
      .overrideProvider(NOTIFICATION_DISPATCH_OPTIONS)
      .useValue({
        ackTimeoutMs: 300,
        retryBackoffMs: [250, 250],
        maxConcurrency: 20,
      })
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
    directory = moduleRef.get(NOTIFICATION_RECIPIENT_DIRECTORY);
    notifications = moduleRef.get(NOTIFICATION_REPOSITORY);
    dispatcher = moduleRef.get(NotificationDispatcherService);
    custody = moduleRef.get(CustodyService);
    hashService = moduleRef.get(HashService);
    validationService = moduleRef.get(DeliveryValidationService);
    monitoraAuth = `Bearer ${await makeToken(["MONITORA"], makeUuid(800))}`;
  });

  afterEach(async () => {
    await dispatcher.drain();
    while (sockets.length > 0) {
      sockets.pop()?.disconnect();
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Familia vinculada en asistencia (#8/#9), pasarela (#14) y directorio de notificaciones. */
  function family(n: number): Family {
    const f = {
      user: makeUuid(3000 + n),
      guardian: makeUuid(4000 + n),
      student: makeUuid(1000 + n),
    };
    guardianLinks.registerLink({
      id_usuario: f.user,
      id_acudiente: f.guardian,
      id_estudiante: f.student,
    });
    directory.registerGuardian(f.student, f.guardian);
    return f;
  }

  async function connectFamily(
    f: Family,
    opts: { ack?: boolean; roles?: string[] } = {},
  ): Promise<Inbox> {
    const socket = createSocketClient(`${baseUrl}/telemetria`, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      auth: { token: await makeToken(opts.roles ?? ["ACUDIENTE"], f.user) },
    });
    sockets.push(socket);
    const inbox: Inbox = { socket, items: [] };
    socket.on(
      "notification:new",
      (n: OutboundNotification, ack?: (r: unknown) => void) => {
        inbox.items.push(n);
        if (opts.ack !== false) {
          ack?.({ recibida: true, id_notificacion: n.id_notificacion });
        }
      },
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", reject);
    });
    // Margen para que `handleConnection` termine de unir la sala familiar.
    await sleep(50);
    return inbox;
  }

  async function seedAfternoonTrip(tripId: string, families: Family[]) {
    attendance.registerTrip({
      id_viaje: tripId,
      id_ruta: ROUTE_ID,
      estado: TripStateEnum.EN_CURSO,
      jornada: "TARDE",
      capacidad_nominal: 15,
      total_a_bordo: 0,
    });
    families.forEach((f, i) => {
      attendance.registerStudent({
        id_estudiante: f.student,
        id_colegio: SCHOOL_ID,
        activo: true,
        qr_token_hash: hashService.sha256(qrOf(tripId, i)),
        id_acudiente_titular: f.guardian,
      });
      attendance.registerRouteAssignment({
        id_estudiante: f.student,
        id_ruta: ROUTE_ID,
        ciclo_horario: "AMBOS",
        activa: true,
      });
      attendance.registerGuardianLink({
        id_acudiente: f.guardian,
        id_estudiante: f.student,
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

  const qrOf = (tripId: string, i: number) =>
    `QR-NT15-${tripId.slice(-4)}-${i}`;

  const board = (tripId: string, i: number) =>
    request(app.getHttpServer())
      .post("/asistencia/abordaje")
      .set("Authorization", monitoraAuth)
      .send({
        id_viaje: tripId,
        qr_token: qrOf(tripId, i),
        coordenadas_gps: BOARDING_COORDS,
      })
      .expect(200);

  describe("Criterio de aceptación", () => {
    it("abordaje y desembarque → evento a la sala familiar + fila en notificacion, en < 2,5 s", async () => {
      const trip = makeUuid(100);
      const fam = family(1);
      await seedAfternoonTrip(trip, [fam]);
      const inbox = await connectFamily(fam);

      // 1. Abordaje (#8)
      const t0 = Date.now();
      await board(trip, 0);
      await waitFor(() => inbox.items.length === 1);
      const boardingLatency = Date.now() - t0;

      expect(boardingLatency).toBeLessThan(NOTIFICATION_LATENCY_BUDGET_MS);
      expect(inbox.items[0]).toMatchObject({
        codigo_tipo: "ABORDAJE_EXITOSO",
        id_acudiente: fam.guardian,
        id_estudiante: fam.student,
        id_viaje: trip,
        titulo: "Abordaje confirmado",
        intento: 1,
      });
      await dispatcher.drain();
      const boardingRow = notifications.findByIdempotencyKey(
        `abordaje:${trip}:${fam.student}`,
      );
      expect(boardingRow).toMatchObject({
        id_notificacion: inbox.items[0].id_notificacion,
        codigo_tipo: "ABORDAJE_EXITOSO",
        canal: "PUSH",
        estado_envio: "ENTREGADA",
        intentos_realizados: 1,
      });

      // 2. Desembarque exitoso (#9)
      const t1 = Date.now();
      const res = await request(app.getHttpServer())
        .post("/asistencia/descenso")
        .set("Authorization", monitoraAuth)
        .send({
          id_viaje: trip,
          id_estudiante: fam.student,
          tipo_receptor: ReceptorType.ACUDIENTE,
          documento_receptor: GUARDIAN_DOC,
          coordenadas_gps: HOME_COORDS,
        })
        .expect(200);
      await waitFor(() => inbox.items.length === 2);
      expect(Date.now() - t1).toBeLessThan(NOTIFICATION_LATENCY_BUDGET_MS);
      expect(inbox.items[1]).toMatchObject({
        codigo_tipo: "DESCENSO_EXITOSO",
        id_estudiante: fam.student,
        payload: expect.objectContaining({
          estado_custodia: "ENTREGADO_ACUDIENTE",
        }),
      });
      await dispatcher.drain();
      expect(
        notifications.findByIdempotencyKey(
          `descenso:${res.body.id_entrega}:${fam.guardian}`,
        ),
      ).toMatchObject({
        estado_envio: "ENTREGADA",
        codigo_tipo: "DESCENSO_EXITOSO",
      });
    });

    it("aproximación: transición FSM a EN_ESPERA_ABORDAJE (POST /custody/transitions) → PROXIMIDAD_PARADA", async () => {
      const trip = makeUuid(110);
      const fam = family(2);
      await custody.enrollStudentInTrip(trip, fam.student);
      const inbox = await connectFamily(fam);

      const t0 = Date.now();
      await request(app.getHttpServer())
        .post("/custody/transitions")
        .set("Authorization", monitoraAuth)
        .send({
          id_viaje: trip,
          id_estudiante: fam.student,
          estado_destino: FsmCustodyState.EN_ESPERA_ABORDAJE,
          tipo_recorrido: TripDirection.MANANA,
          disparador_evento: "LLEGADA_PARADA_ABORDAJE",
          latitud: BOARDING_COORDS.latitud,
          longitud: BOARDING_COORDS.longitud,
        })
        .expect(201);
      await waitFor(() => inbox.items.length === 1);

      expect(Date.now() - t0).toBeLessThan(NOTIFICATION_LATENCY_BUDGET_MS);
      expect(inbox.items[0]).toMatchObject({
        codigo_tipo: "PROXIMIDAD_PARADA",
        id_viaje: trip,
        id_estudiante: fam.student,
        payload: expect.objectContaining({
          estado_origen: "NO_INICIADO",
          estado_custodia: "EN_ESPERA_ABORDAJE",
          disparador_evento: "LLEGADA_PARADA_ABORDAJE",
        }),
      });
      await dispatcher.drain();
      const row = notifications
        .listAll()
        .find((n) => n.id_notificacion === inbox.items[0].id_notificacion);
      expect(row).toMatchObject({
        estado_envio: "ENTREGADA",
        codigo_tipo: "PROXIMIDAD_PARADA",
      });
    });
  });

  describe("Segmentación y privacidad", () => {
    it("solo la familia legitimada recibe la notificación (otras familias y personal no)", async () => {
      const trip = makeUuid(120);
      const famA = family(3);
      const famB = family(4);
      await seedAfternoonTrip(trip, [famA, famB]);
      const inboxA = await connectFamily(famA);
      const inboxB = await connectFamily(famB);
      const staff = await connectFamily(
        {
          user: makeUuid(3900),
          guardian: makeUuid(4900),
          student: makeUuid(1900),
        },
        { roles: ["MONITORA"] },
      );

      await board(trip, 0);
      await waitFor(() => inboxA.items.length === 1);
      await dispatcher.drain();
      await sleep(100);

      expect(inboxA.items[0].id_estudiante).toBe(famA.student);
      expect(inboxB.items).toEqual([]);
      expect(staff.items).toEqual([]);
    });

    it("sin JWT no hay socket y, por tanto, no hay sala familiar", async () => {
      const socket = createSocketClient(`${baseUrl}/telemetria`, {
        transports: ["websocket"],
        forceNew: true,
        reconnection: false,
      });
      sockets.push(socket);
      await expect(
        new Promise((resolve, reject) => {
          socket.once("connect", () => resolve(true));
          socket.once("connect_error", reject);
        }),
      ).rejects.toMatchObject({ data: { code: "TOKEN_REQUIRED" } });
    });
  });

  describe("Reintentos y confirmación de entrega", () => {
    it("acudiente desconectado al abordar: reintenta y entrega al conectarse", async () => {
      const trip = makeUuid(130);
      const fam = family(5);
      await seedAfternoonTrip(trip, [fam]);

      await board(trip, 0);
      await sleep(50);
      const inbox = await connectFamily(fam);
      await waitFor(() => inbox.items.length === 1, 3000);
      await dispatcher.drain();

      expect(inbox.items[0].intento).toBeGreaterThanOrEqual(2);
      expect(
        notifications.findByIdempotencyKey(`abordaje:${trip}:${fam.student}`),
      ).toMatchObject({
        estado_envio: "ENTREGADA",
        intentos_realizados: inbox.items[0].intento,
      });
    });

    it("cliente que no confirma (sin ack) → 3 intentos y FALLIDA con el motivo", async () => {
      const trip = makeUuid(140);
      const fam = family(6);
      await seedAfternoonTrip(trip, [fam]);
      const inbox = await connectFamily(fam, { ack: false });

      await board(trip, 0);
      await waitFor(() => inbox.items.length === 3, 4000);
      await dispatcher.drain();

      expect(inbox.items.map((n) => n.intento)).toEqual([1, 2, 3]);
      expect(new Set(inbox.items.map((n) => n.id_notificacion)).size).toBe(1);
      expect(
        notifications.findByIdempotencyKey(`abordaje:${trip}:${fam.student}`),
      ).toMatchObject({
        estado_envio: "FALLIDA",
        intentos_realizados: 3,
        ultimo_error: expect.stringContaining("SIN_CONFIRMACION_ACK"),
      });
    });
  });
});
