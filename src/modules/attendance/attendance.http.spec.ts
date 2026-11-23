import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { io as createSocketClient, Socket } from "socket.io-client";
import * as request from "supertest";
import { CryptoModule } from "@common/crypto/crypto.module";
import { HashService } from "@common/crypto/hash.service";
import { TripStateEnum } from "@common/enums/trip-state.enum";
import { AllExceptionsFilter } from "@common/filters/all-exceptions.filter";
import { AuthModule } from "../auth/auth.module";
import { TokenService } from "../auth/token.service";
import { AttendanceModule } from "./attendance.module";
import { ATTENDANCE_REPOSITORY } from "./domain/attendance-repository.port";
import {
  BoardingResultCode,
  OvercapacityAlertEventPayload,
  StudentBoardedEventPayload,
} from "./domain/attendance.types";
import { InMemoryAttendanceRepository } from "./infrastructure/in-memory-attendance.repository";

const makeUuid = (suffix: number) =>
  `018e38d9-3f00-7200-b000-${String(suffix).padStart(12, "0")}`;

const PEREIRA_COORDS = { latitud: 4.8133, longitud: -75.6961 };

describe("POST /asistencia/abordaje (HTTP + RBAC + Socket.IO + Concurrencia Issue #8)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let tokens: TokenService;
  let repository: InMemoryAttendanceRepository;
  let hashService: HashService;

  const routeId = makeUuid(1);

  const makeToken = (roles: string[], userId = makeUuid(99), mfa = true) =>
    tokens.signAccessToken(
      {
        id_usuario: userId,
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
              ATTENDANCE_USE_POSTGRES: "false",
              CUSTODY_USE_POSTGRES: "false",
              CUSTODY_MORNING_JOB_ENABLED: "false",
              QR_DYNAMIC_HMAC_SECRET:
                "secreto-qr-dinamico-de-prueba-0123456789",
            }),
          ],
        }),
        CryptoModule,
        AuthModule,
        AttendanceModule,
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

    const address = app.getHttpServer().address();
    const port = typeof address === "string" ? 0 : address.port;
    baseUrl = `http://127.0.0.1:${port}`;

    tokens = moduleRef.get(TokenService);
    repository = moduleRef.get(ATTENDANCE_REPOSITORY);
    hashService = moduleRef.get(HashService);
  });

  afterAll(async () => {
    await app?.close();
  });

  function seedTrip(tripId: string, capacity: number, studentCount: number) {
    repository.registerTrip({
      id_viaje: tripId,
      id_ruta: routeId,
      estado: TripStateEnum.EN_CURSO,
      jornada: "MANANA",
      capacidad_nominal: capacity,
      total_a_bordo: 0,
    });

    const students: Array<{ id: string; qrRaw: string }> = [];
    for (let i = 1; i <= studentCount; i++) {
      const id = makeUuid(1000 + Number(tripId.slice(-3)) * 50 + i);
      const qrRaw = `QR-HTTP-${tripId.slice(-4)}-${i}`;
      repository.registerStudent({
        id_estudiante: id,
        activo: true,
        qr_token_hash: hashService.sha256(qrRaw),
        id_acudiente_titular: makeUuid(8000 + i),
      });
      repository.registerRouteAssignment({
        id_estudiante: id,
        id_ruta: routeId,
        ciclo_horario: "AMBOS",
        activa: true,
      });
      students.push({ id, qrRaw });
    }
    return students;
  }

  async function connectSocket(): Promise<Socket> {
    const socket = createSocketClient(`${baseUrl}/asistencia`, {
      transports: ["websocket"],
      forceNew: true,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", reject);
    });
    return socket;
  }

  it("exige JWT (401), restringe por RBAC (403) y valida DTO/WGS84 (400)", async () => {
    await request(app.getHttpServer())
      .post("/asistencia/abordaje")
      .send({})
      .expect(401);

    const parentAuth = `Bearer ${await makeToken(["ACUDIENTE"], makeUuid(501), false)}`;
    const driverAuth = `Bearer ${await makeToken(["CONDUCTOR"], makeUuid(502), false)}`;
    const monitoraAuth = `Bearer ${await makeToken(["MONITORA"], makeUuid(503), false)}`;

    const validPayload = {
      id_viaje: makeUuid(10),
      qr_token: "QR-TEST-RBAC",
      coordenadas_gps: PEREIRA_COORDS,
    };

    await request(app.getHttpServer())
      .post("/asistencia/abordaje")
      .set("Authorization", parentAuth)
      .send(validPayload)
      .expect(403);

    await request(app.getHttpServer())
      .post("/asistencia/abordaje")
      .set("Authorization", driverAuth)
      .send(validPayload)
      .expect(403);

    await request(app.getHttpServer())
      .post("/asistencia/abordaje")
      .set("Authorization", monitoraAuth)
      .send({
        id_viaje: "no-es-uuid",
        qr_token: "",
        coordenadas_gps: { latitud: 120, longitud: -75.69 },
      })
      .expect(400);
  });

  it("emite student:boarded y coordination:overcapacity_alert reales vía Socket.IO y cumple Criterio de Aceptación #8 (15/15 -> #16 DENEGADO_SOBRECUPO)", async () => {
    const tripId = makeUuid(101);
    const students = seedTrip(tripId, 15, 16);
    const monitoraAuth = `Bearer ${await makeToken(["MONITORA"], makeUuid(504), false)}`;

    const socket = await connectSocket();
    const boardedEvents: StudentBoardedEventPayload[] = [];
    const coordAlerts: OvercapacityAlertEventPayload[] = [];

    socket.on("student:boarded", (payload: StudentBoardedEventPayload) => {
      if (payload.id_viaje === tripId) {
        boardedEvents.push(payload);
      }
    });
    socket.on(
      "coordination:overcapacity_alert",
      (payload: OvercapacityAlertEventPayload) => {
        if (payload.id_viaje === tripId) {
          coordAlerts.push(payload);
        }
      },
    );

    await new Promise<void>((resolve) => {
      socket.emit("subscribe:coordination", {}, () => resolve());
    });

    try {
      for (let i = 0; i < 15; i++) {
        const res = await request(app.getHttpServer())
          .post("/asistencia/abordaje")
          .set("Authorization", monitoraAuth)
          .set("X-Idempotency-Key", `http-cap15-${i + 1}`)
          .send({
            id_viaje: tripId,
            qr_token: students[i].qrRaw,
            coordenadas_gps: PEREIRA_COORDS,
          })
          .expect(200);

        expect(res.body.aprobado).toBe(true);
        expect(res.body.codigo).toBe(BoardingResultCode.ABORDAJE_EXITOSO);
        expect(res.body.total_a_bordo).toBe(i + 1);
        expect(res.body.evento_realtime_emitido).toBe("student:boarded");
        expect(res.body.notificacion_acudiente_encolada).toBe(true);
        expect(res.body.latencia_ms).toBeLessThan(200);
      }

      // Reintento con misma cabecera X-Idempotency-Key -> ABORDAJE_PREVIO_EXISTE no fatal
      const dupRes = await request(app.getHttpServer())
        .post("/asistencia/abordaje")
        .set("Authorization", monitoraAuth)
        .set("X-Idempotency-Key", "http-cap15-1")
        .send({
          id_viaje: tripId,
          qr_token: students[0].qrRaw,
          coordenadas_gps: PEREIRA_COORDS,
        })
        .expect(200);

      expect(dupRes.body.aprobado).toBe(false);
      expect(dupRes.body.codigo).toBe(
        BoardingResultCode.ABORDAJE_PREVIO_EXISTE,
      );
      expect(dupRes.body.duplicado_por_idempotencia).toBe(true);
      expect(dupRes.body.total_a_bordo).toBe(15);

      // Estudiante #16 -> DENEGADO_SOBRECUPO no fatal + alerta Socket.IO a Coordinación
      const overcapRes = await request(app.getHttpServer())
        .post("/asistencia/abordaje")
        .set("Authorization", monitoraAuth)
        .set("X-Idempotency-Key", "http-cap15-16")
        .send({
          id_viaje: tripId,
          qr_token: students[15].qrRaw,
          coordenadas_gps: PEREIRA_COORDS,
        })
        .expect(200);

      expect(overcapRes.body.aprobado).toBe(false);
      expect(overcapRes.body.codigo).toBe(
        BoardingResultCode.DENEGADO_SOBRECUPO,
      );
      expect(overcapRes.body.total_a_bordo).toBe(15);
      expect(overcapRes.body.capacidad_nominal).toBe(15);
      expect(overcapRes.body.id_incidente).toBeTruthy();
      expect(overcapRes.body.alerta_coordinacion_emitida).toBe(true);

      // Esperar propagación de los eventos Socket.IO por loopback
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(boardedEvents).toHaveLength(15);
      expect(coordAlerts).toHaveLength(1);
      expect(coordAlerts[0].id_incidente).toBe(overcapRes.body.id_incidente);
    } finally {
      socket.disconnect();
    }
  });

  it("estrés HTTP concurrente: 20 solicitudes simultáneas sobre vehículo capacidad 5 -> 5 aprobadas y 15 DENEGADO_SOBRECUPO (< 200ms)", async () => {
    const tripId = makeUuid(102);
    const students = seedTrip(tripId, 5, 20);
    const monitoraAuth = `Bearer ${await makeToken(["MONITORA"], makeUuid(505), false)}`;

    const responses = await Promise.all(
      students.map((student, idx) =>
        request(app.getHttpServer())
          .post("/asistencia/abordaje")
          .set("Authorization", monitoraAuth)
          .set("X-Idempotency-Key", `http-stress-20-${idx + 1}`)
          .send({
            id_viaje: tripId,
            qr_token: student.qrRaw,
            coordenadas_gps: PEREIRA_COORDS,
          })
          .expect(200),
      ),
    );

    const approved = responses.filter((r) => r.body.aprobado === true);
    const denied = responses.filter(
      (r) =>
        r.body.aprobado === false &&
        r.body.codigo === BoardingResultCode.DENEGADO_SOBRECUPO,
    );

    expect(approved).toHaveLength(5);
    expect(denied).toHaveLength(15);
    expect(responses.every((r) => r.body.latencia_ms < 200)).toBe(true);

    const occupancy = await repository.getTripOccupancy(tripId);
    expect(occupancy?.total_a_bordo).toBe(5);
  });
});
