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
import { FsmCustodyState } from "../custody/domain/custody.types";
import { TripsModule } from "../trips/trips.module";
import { AttendanceModule } from "./attendance.module";
import { DeliveryValidationService } from "./delivery-validation.service";
import { ATTENDANCE_REPOSITORY } from "./domain/attendance-repository.port";
import {
  DisembarkOutcomeType,
  DisembarkResultCode,
  FailedDeliveryAlertEventPayload,
  ReceptorType,
  SchoolCustodyFinalizedEventPayload,
  StudentDisembarkedEventPayload,
} from "./domain/disembark.types";
import { InMemoryAttendanceRepository } from "./infrastructure/in-memory-attendance.repository";

const makeUuid = (suffix: number) =>
  `018e38d9-3f00-7200-9100-${String(suffix).padStart(12, "0")}`;

const PEREIRA_HOME_COORDS = { latitud: 4.8133, longitud: -75.6961 };
const SAN_BENITO_COORDS = { latitud: 4.8143, longitud: -75.6946 };

describe("POST /asistencia/descenso & POST /asistencia/custodia/finalizar-sede (HTTP + RBAC + Socket.IO Issue #9)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let tokens: TokenService;
  let repository: InMemoryAttendanceRepository;
  let hashService: HashService;
  let validationService: DeliveryValidationService;

  const schoolId = makeUuid(1);
  const routeId = makeUuid(2);
  const coordinatorId = makeUuid(3);
  const guardianId = makeUuid(4);
  const authorizedId = makeUuid(5);

  const makeToken = (roles: string[], userId = makeUuid(99), mfa = true) =>
    tokens.signAccessToken(
      {
        id_usuario: userId,
        email: "operacion@caminoseguro.co",
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
              APP_BLIND_INDEX_HMAC_KEY: Buffer.from(
                "http-hmac-key-32-bytes-issue-09!",
              ).toString("base64"),
              APP_ENCRYPTION_MASTER_KEY: Buffer.from(
                "http-aes-key-32-bytes-issue-009!",
              ).toString("base64"),
            }),
          ],
        }),
        CryptoModule,
        AuthModule,
        AttendanceModule,
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
    await app.listen(0);

    const address = app.getHttpServer().address();
    const port = typeof address === "string" ? 0 : address.port;
    baseUrl = `http://127.0.0.1:${port}`;

    tokens = moduleRef.get(TokenService);
    repository = moduleRef.get(ATTENDANCE_REPOSITORY);
    hashService = moduleRef.get(HashService);
    validationService = moduleRef.get(DeliveryValidationService);

    repository.registerSchoolCoordinator({
      id_coordinador: coordinatorId,
      id_colegio: schoolId,
      nombres: "Beatriz",
      apellidos: "Rectoría",
      cargo: "Coordinadora de Convivencia",
    });
  });

  afterAll(async () => {
    await app?.close();
  });

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

  async function seedAfternoonBoarded(
    tripId: string,
    studentIds: string[],
    monitoraAuth: string,
  ) {
    repository.registerTrip({
      id_viaje: tripId,
      id_ruta: routeId,
      estado: TripStateEnum.EN_CURSO,
      jornada: "TARDE",
      capacidad_nominal: 15,
      total_a_bordo: 0,
    });

    for (let i = 0; i < studentIds.length; i++) {
      const id = studentIds[i];
      const qrRaw = `QR-HTTP-DIS-${tripId.slice(-4)}-${i + 1}`;
      repository.registerStudent({
        id_estudiante: id,
        id_colegio: schoolId,
        activo: true,
        qr_token_hash: hashService.sha256(qrRaw),
        id_acudiente_titular: guardianId,
      });
      repository.registerRouteAssignment({
        id_estudiante: id,
        id_ruta: routeId,
        ciclo_horario: "AMBOS",
        activa: true,
      });
      repository.registerGuardianLink({
        id_acudiente: guardianId,
        id_estudiante: id,
        nombres: "Sofía",
        apellidos: "Madre",
        documento_blind_index:
          validationService.computeDocumentBlindIndex("1088555444"),
        parentesco: "MADRE",
        es_tutor_principal: true,
        orden_notificacion: 1,
      });

      await request(app.getHttpServer())
        .post("/asistencia/abordaje")
        .set("Authorization", monitoraAuth)
        .send({
          id_viaje: tripId,
          qr_token: qrRaw,
          coordenadas_gps: SAN_BENITO_COORDS,
        })
        .expect(200);
    }
  }

  it("exige JWT (401), aplica RBAC estricto y separación de funciones en /finalizar-sede (403) y valida DTO (400)", async () => {
    await request(app.getHttpServer())
      .post("/asistencia/descenso")
      .send({})
      .expect(401);

    await request(app.getHttpServer())
      .post("/asistencia/custodia/finalizar-sede")
      .send({})
      .expect(401);

    const parentAuth = `Bearer ${await makeToken(["ACUDIENTE"], makeUuid(501), false)}`;
    const monitoraAuth = `Bearer ${await makeToken(["MONITORA"], makeUuid(502), false)}`;

    await request(app.getHttpServer())
      .post("/asistencia/descenso")
      .set("Authorization", parentAuth)
      .send({
        id_viaje: makeUuid(10),
        id_estudiante: makeUuid(11),
        tipo_receptor: ReceptorType.ACUDIENTE,
        documento_receptor: "1088555444",
        coordenadas_gps: PEREIRA_HOME_COORDS,
      })
      .expect(403);

    // Separación de funciones ASVS V4.1: MONITORA no puede cerrar formalmente custodia en sede
    await request(app.getHttpServer())
      .post("/asistencia/custodia/finalizar-sede")
      .set("Authorization", monitoraAuth)
      .send({
        id_viaje: makeUuid(10),
        id_estudiante: makeUuid(11),
        recibido_por_coordinador: coordinatorId,
        coordenadas_gps: SAN_BENITO_COORDS,
      })
      .expect(403);

    // Payload inválido (400)
    await request(app.getHttpServer())
      .post("/asistencia/descenso")
      .set("Authorization", monitoraAuth)
      .send({
        id_viaje: "invalido",
        id_estudiante: "invalido",
        coordenadas_gps: { latitud: 200, longitud: -75.69 },
      })
      .expect(400);
  });

  it("flujo completo HTTP + Socket.IO: entrega válida a autorizado, no-entrega con retorno a sede (sin decremento + bloqueo cierre 409) y cierre formal en sede (decremento + cierre 200)", async () => {
    const tripId = makeUuid(201);
    const studentDelivered = makeUuid(2001);
    const studentReturned = makeUuid(2002);
    const monitoraAuth = `Bearer ${await makeToken(["MONITORA"], makeUuid(503), false)}`;
    const coordAuth = `Bearer ${await makeToken(["COORDINADORA_CONVIVENCIA"], makeUuid(504), true)}`;

    await seedAfternoonBoarded(
      tripId,
      [studentDelivered, studentReturned],
      monitoraAuth,
    );

    repository.registerAuthorizedAdultLink({
      id_autorizado: authorizedId,
      id_estudiante: studentDelivered,
      nombres: "Elena",
      apellidos: "Autorizada",
      documento_blind_index:
        validationService.computeDocumentBlindIndex("42111222"),
      parentesco: "ABUELA",
      prioridad_retiro: 1,
      adulto_activo: true,
      autorizacion_activa: true,
      autorizado_hasta: new Date(Date.now() + 86_400_000),
      expediente_revocado: false,
    });

    const socket = await connectSocket();
    const disembarkedEvents: StudentDisembarkedEventPayload[] = [];
    const failedAlerts: FailedDeliveryAlertEventPayload[] = [];
    const finalizedEvents: SchoolCustodyFinalizedEventPayload[] = [];

    socket.on("student:disembarked", (p: StudentDisembarkedEventPayload) => {
      if (p.id_viaje === tripId) disembarkedEvents.push(p);
    });
    socket.on(
      "coordination:failed_delivery_alert",
      (p: FailedDeliveryAlertEventPayload) => {
        if (p.id_viaje === tripId) failedAlerts.push(p);
      },
    );
    socket.on(
      "custody:school_return_completed",
      (p: SchoolCustodyFinalizedEventPayload) => {
        if (p.id_viaje === tripId) finalizedEvents.push(p);
      },
    );

    await new Promise<void>((resolve) => {
      socket.emit("subscribe:coordination", {}, () => resolve());
    });

    try {
      // 1. Entrega exitosa a ADULTO_AUTORIZADO vigente (2 -> 1 a bordo)
      const okRes = await request(app.getHttpServer())
        .post("/asistencia/descenso")
        .set("Authorization", monitoraAuth)
        .set("X-Idempotency-Key", "http-dis-ok-1")
        .send({
          id_viaje: tripId,
          id_estudiante: studentDelivered,
          tipo_receptor: ReceptorType.ADULTO_AUTORIZADO,
          documento_receptor: "42.111.222",
          coordenadas_gps: PEREIRA_HOME_COORDS,
        })
        .expect(200);

      expect(okRes.body.aprobado).toBe(true);
      expect(okRes.body.codigo).toBe(DisembarkResultCode.DESCENSO_EXITOSO);
      expect(okRes.body.total_a_bordo).toBe(1);
      expect(okRes.body.estado_custodia).toBe(
        FsmCustodyState.ENTREGADO_ACUDIENTE,
      );

      // 2. Intento con receptor inexistente para studentReturned -> 403 Forbidden
      await request(app.getHttpServer())
        .post("/asistencia/descenso")
        .set("Authorization", monitoraAuth)
        .send({
          id_viaje: tripId,
          id_estudiante: studentReturned,
          tipo_receptor: ReceptorType.ADULTO_AUTORIZADO,
          documento_receptor: "000000000",
          coordenadas_gps: PEREIRA_HOME_COORDS,
        })
        .expect(403);

      // 3. Monitora reporta DESEMBARQUE_FALLIDO_RETORNO (total_a_bordo sigue en 1)
      const failRes = await request(app.getHttpServer())
        .post("/asistencia/descenso")
        .set("Authorization", monitoraAuth)
        .set("X-Idempotency-Key", "http-dis-fail-1")
        .send({
          id_viaje: tripId,
          id_estudiante: studentReturned,
          resultado_entrega: DisembarkOutcomeType.DESEMBARQUE_FALLIDO_RETORNO,
          coordenadas_gps: PEREIRA_HOME_COORDS,
          observaciones_fallido: "Domicilio sin adulto autorizado.",
        })
        .expect(200);

      expect(failRes.body.aprobado).toBe(false);
      expect(failRes.body.codigo).toBe(
        DisembarkResultCode.DESEMBARQUE_FALLIDO_RETORNO,
      );
      expect(failRes.body.estado_custodia).toBe(
        FsmCustodyState.RETORNO_SEDE_POR_FALLA_ENTREGA,
      );
      expect(failRes.body.total_a_bordo).toBe(1);
      expect(failRes.body.alerta_coordinacion_emitida).toBe(true);
      expect(failRes.body.notificaciones_acudientes_encoladas).toBe(1);

      // 4. Intento de cerrar el viaje mientras el menor sigue en retorno a sede -> 409 Conflict
      await request(app.getHttpServer())
        .patch(`/trips/${tripId}/finish`)
        .set("Authorization", monitoraAuth)
        .expect(409);

      // 5. Coordinación cierra formalmente la custodia en sede -> total_a_bordo baja a 0
      const schoolRes = await request(app.getHttpServer())
        .post("/asistencia/custodia/finalizar-sede")
        .set("Authorization", coordAuth)
        .set("X-Idempotency-Key", "http-sede-final-1")
        .send({
          id_viaje: tripId,
          id_estudiante: studentReturned,
          recibido_por_coordinador: coordinatorId,
          coordenadas_gps: SAN_BENITO_COORDS,
          observaciones: "Estudiante recibido en coordinación.",
        })
        .expect(200);

      expect(schoolRes.body.finalizado).toBe(true);
      expect(schoolRes.body.codigo).toBe(
        DisembarkResultCode.CUSTODIA_SEDE_FINALIZADA,
      );
      expect(schoolRes.body.estado_custodia).toBe(FsmCustodyState.EN_COLEGIO);
      expect(schoolRes.body.total_a_bordo).toBe(0);
      expect(schoolRes.body.firma_digital_hash).toMatch(/^[a-f0-9]{64}$/);

      // 6. Ahora el viaje sí cierra en FINALIZADO (200)
      const finishTripRes = await request(app.getHttpServer())
        .patch(`/trips/${tripId}/finish`)
        .set("Authorization", monitoraAuth)
        .expect(200);
      expect(finishTripRes.body.estado).toBe(TripStateEnum.FINALIZADO);

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(disembarkedEvents).toHaveLength(1);
      expect(failedAlerts).toHaveLength(1);
      expect(finalizedEvents).toHaveLength(1);
    } finally {
      socket.disconnect();
    }
  });
});
