import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import * as request from "supertest";
import { CryptoModule } from "@common/crypto/crypto.module";
import { HashService } from "@common/crypto/hash.service";
import { TripStateEnum } from "@common/enums/trip-state.enum";
import { AllExceptionsFilter } from "@common/filters/all-exceptions.filter";
import { AttendanceModule } from "../attendance/attendance.module";
import { ATTENDANCE_REPOSITORY } from "../attendance/domain/attendance-repository.port";
import { BoardingResultCode } from "../attendance/domain/attendance.types";
import { InMemoryAttendanceRepository } from "../attendance/infrastructure/in-memory-attendance.repository";
import { AuthModule } from "../auth/auth.module";
import { TokenService } from "../auth/token.service";
import { CustodyModule } from "../custody/custody.module";
import { CUSTODY_REPOSITORY } from "../custody/domain/custody-repository.port";
import { FsmCustodyState, TripDirection } from "../custody/domain/custody.types";
import { InMemoryCustodyRepository } from "../custody/infrastructure/in-memory-custody.repository";
import { OCCASIONAL_PASSENGER_REPOSITORY } from "./domain/occasional-passenger-repository.port";
import {
  OccasionalRejectionReason,
  OccasionalRequestStatus,
} from "./domain/occasional-passenger.types";
import { InMemoryOccasionalPassengerRepository } from "./infrastructure/in-memory-occasional-passenger.repository";
import { PASSENGERS_CLOCK } from "./occasional-booking.service";
import { PassengersModule } from "./passengers.module";

const makeUuid = (suffix: number) =>
  `018e38d9-3f00-7200-a700-${String(suffix).padStart(12, "0")}`;

describe("HTTP + RBAC + MFA + Concurrencia — Pasajeros Ocasionales (Issue #11)", () => {
  let app: INestApplication;
  let tokens: TokenService;
  let passengersRepo: InMemoryOccasionalPassengerRepository;
  let attendanceRepo: InMemoryAttendanceRepository;
  let custodyRepo: InMemoryCustodyRepository;
  let hashService: HashService;
  let mockNow: Date;

  const schoolId = makeUuid(1);
  const coordinatorUserId = makeUuid(10);
  const coordinatorId = makeUuid(11);

  const makeToken = (roles: string[], userId: string, mfa = false) =>
    tokens.signAccessToken(
      {
        id_usuario: userId,
        email: `${userId}@caminoseguro.co`,
        roles,
      },
      mfa,
    );

  beforeAll(async () => {
    mockNow = new Date("2026-11-30T04:00:00.000-05:00");

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
              PASSENGERS_USE_POSTGRES: "false",
              CUSTODY_MORNING_JOB_ENABLED: "false",
              APP_BLIND_INDEX_HMAC_KEY: Buffer.from(
                "http-hmac-key-32-bytes-issue-11!",
              ).toString("base64"),
              APP_ENCRYPTION_MASTER_KEY: Buffer.from(
                "http-aes-key-32-bytes-issue-011!",
              ).toString("base64"),
            }),
          ],
        }),
        CryptoModule,
        AuthModule,
        CustodyModule,
        AttendanceModule,
        PassengersModule,
      ],
    })
      .overrideProvider(PASSENGERS_CLOCK)
      .useValue(() => mockNow)
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

    tokens = moduleRef.get(TokenService);
    passengersRepo = moduleRef.get(OCCASIONAL_PASSENGER_REPOSITORY);
    attendanceRepo = moduleRef.get(ATTENDANCE_REPOSITORY);
    custodyRepo = moduleRef.get(CUSTODY_REPOSITORY);
    hashService = moduleRef.get(HashService);

    passengersRepo.registerCoordinator({
      id_coordinador: coordinatorId,
      id_usuario: coordinatorUserId,
      id_colegio: schoolId,
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it("exige JWT (401), RBAC estricto (403), MFA en aprobación (401) y valida DTO (400)", async () => {
    await request(app.getHttpServer())
      .post("/pasajeros-ocasionales/solicitar")
      .send({})
      .expect(401);

    await request(app.getHttpServer())
      .post("/pasajeros-ocasionales/aprobar")
      .send({})
      .expect(401);

    const monitoraAuth = `Bearer ${await makeToken(["MONITORA"], makeUuid(501), false)}`;
    const parentAuth = `Bearer ${await makeToken(["ACUDIENTE"], makeUuid(502), false)}`;
    const coordNoMfa = `Bearer ${await makeToken(["COORDINADORA_CONVIVENCIA"], coordinatorUserId, false)}`;

    // MONITORA no puede solicitar cupo ocasional
    await request(app.getHttpServer())
      .post("/pasajeros-ocasionales/solicitar")
      .set("Authorization", monitoraAuth)
      .send({
        id_viaje: makeUuid(900),
        id_estudiante: makeUuid(901),
      })
      .expect(403);

    // DTO inválido -> 400
    await request(app.getHttpServer())
      .post("/pasajeros-ocasionales/solicitar")
      .set("Authorization", parentAuth)
      .send({
        id_viaje: "no-es-uuid",
        id_estudiante: makeUuid(901),
      })
      .expect(400);

    // ACUDIENTE no puede aprobar solicitudes -> 403
    await request(app.getHttpServer())
      .post("/pasajeros-ocasionales/aprobar")
      .set("Authorization", parentAuth)
      .send({ id_pasajero_ocasional: makeUuid(902) })
      .expect(403);

    // COORDINADORA_CONVIVENCIA sin MFA -> 401
    await request(app.getHttpServer())
      .post("/pasajeros-ocasionales/aprobar")
      .set("Authorization", coordNoMfa)
      .send({ id_pasajero_ocasional: makeUuid(902) })
      .expect(401);
  });

  it("Criterio de Aceptación HTTP: viaje 06:30 AM sin inasistencias + solicitud 05:00 AM retorna 422 con ambos motivos", async () => {
    const testRouteId = makeUuid(1000);
    const tripId = makeUuid(1001);
    const regularId = makeUuid(1002);
    const occasionalId = makeUuid(1003);
    const parentUserId = makeUuid(1004);
    const parentId = makeUuid(1005);

    passengersRepo.registerTrip({
      id_viaje: tripId,
      id_ruta: testRouteId,
      id_colegio: schoolId,
      jornada: "MANANA",
      estado: TripStateEnum.PROGRAMADO,
      hora_inicio_programada: new Date("2026-11-30T06:30:00.000-05:00"),
      capacidad_nominal: 1,
    });
    passengersRepo.registerStudent({
      id_estudiante: regularId,
      id_colegio: schoolId,
      activo: true,
    });
    passengersRepo.registerRouteAssignment({
      id_estudiante: regularId,
      id_ruta: testRouteId,
      ciclo_horario: "AMBOS",
      activa: true,
    });
    passengersRepo.registerStudent({
      id_estudiante: occasionalId,
      id_colegio: schoolId,
      activo: true,
    });
    passengersRepo.registerGuardianLink({
      id_acudiente: parentId,
      id_usuario: parentUserId,
      id_estudiante: occasionalId,
    });

    mockNow = new Date("2026-11-30T05:00:00.000-05:00");
    const parentAuth = `Bearer ${await makeToken(["ACUDIENTE"], parentUserId, false)}`;

    const res = await request(app.getHttpServer())
      .post("/pasajeros-ocasionales/solicitar")
      .set("Authorization", parentAuth)
      .send({
        id_viaje: tripId,
        id_estudiante: occasionalId,
      })
      .expect(422);

    expect(res.body.code).toBe("REGLAS_PASAJERO_OCASIONAL_INCUMPLIDAS");
    expect(res.body.message).toContain(
      OccasionalRejectionReason.ANTELACION_INSUFICIENTE,
    );
    expect(res.body.message).toContain(
      OccasionalRejectionReason.SIN_VACANTE_POR_INASISTENCIA,
    );
  });

  it("flujo HTTP completo + OWASP ASVS V4.1 + aprobación Coordinación + abordaje QR en Issue #8", async () => {
    const testRouteId = makeUuid(2000);
    const tripId = makeUuid(2001);
    const regularId = makeUuid(2002);
    const occasionalId = makeUuid(2003);
    const parentUserId = makeUuid(2004);
    const parentId = makeUuid(2005);
    const intruderUserId = makeUuid(2006);

    passengersRepo.registerTrip({
      id_viaje: tripId,
      id_ruta: testRouteId,
      id_colegio: schoolId,
      jornada: "MANANA",
      estado: TripStateEnum.PROGRAMADO,
      hora_inicio_programada: new Date("2026-11-30T06:30:00.000-05:00"),
      capacidad_nominal: 1,
    });
    passengersRepo.registerStudent({
      id_estudiante: regularId,
      id_colegio: schoolId,
      activo: true,
    });
    passengersRepo.registerRouteAssignment({
      id_estudiante: regularId,
      id_ruta: testRouteId,
      ciclo_horario: "AMBOS",
      activa: true,
    });
    passengersRepo.registerAbsence({
      id_viaje: tripId,
      id_estudiante: regularId,
      reportado_por_acudiente: makeUuid(2099),
      cupo_liberado: true,
    });
    passengersRepo.registerStudent({
      id_estudiante: occasionalId,
      id_colegio: schoolId,
      activo: true,
    });
    passengersRepo.registerGuardianLink({
      id_acudiente: parentId,
      id_usuario: parentUserId,
      id_estudiante: occasionalId,
    });

    // Preparar Custody y Attendance para verificar integración con Issues #7 y #8
    await custodyRepo.registerTrip({
      id_viaje: tripId,
      id_ruta: testRouteId,
      fecha: "2026-11-30",
      estado: TripStateEnum.EN_CURSO,
      tipo_recorrido: TripDirection.MANANA,
    });
    attendanceRepo.registerTrip({
      id_viaje: tripId,
      id_ruta: testRouteId,
      estado: TripStateEnum.EN_CURSO,
      jornada: "MANANA",
      capacidad_nominal: 1,
      total_a_bordo: 0,
    });
    attendanceRepo.registerStudent({
      id_estudiante: occasionalId,
      id_colegio: schoolId,
      activo: true,
      qr_token_hash: hashService.sha256("regular-qr-http-2003"),
      id_acudiente_titular: parentId,
    });

    mockNow = new Date("2026-11-30T04:15:00.000-05:00");

    // 1. Otro acudiente no vinculado al estudiante -> 403 (OWASP ASVS V4.1)
    const intruderAuth = `Bearer ${await makeToken(["ACUDIENTE"], intruderUserId, false)}`;
    await request(app.getHttpServer())
      .post("/pasajeros-ocasionales/solicitar")
      .set("Authorization", intruderAuth)
      .send({
        id_viaje: tripId,
        id_estudiante: occasionalId,
      })
      .expect(403);

    // 2. Acudiente legítimo radica solicitud -> 201 RADICADA
    const parentAuth = `Bearer ${await makeToken(["ACUDIENTE"], parentUserId, false)}`;
    const reqRes = await request(app.getHttpServer())
      .post("/pasajeros-ocasionales/solicitar")
      .set("Authorization", parentAuth)
      .send({
        id_viaje: tripId,
        id_estudiante: occasionalId,
        motivo: "Visita familiar",
      })
      .expect(201);

    expect(reqRes.body.estado_solicitud).toBe(OccasionalRequestStatus.RADICADA);
    expect(reqRes.body.id_estudiante_que_libera_cupo).toBe(regularId);
    expect(reqRes.body.balance_vacantes.vacantes_netas).toBe(0);

    // 3. Coordinación con MFA aprueba -> 200 APROBADO_COORDINACION + inclusión en viaje_estudiante
    const coordAuth = `Bearer ${await makeToken(["COORDINADORA_CONVIVENCIA"], coordinatorUserId, true)}`;
    const approveRes = await request(app.getHttpServer())
      .post("/pasajeros-ocasionales/aprobar")
      .set("Authorization", coordAuth)
      .send({
        id_pasajero_ocasional: reqRes.body.id_pasajero_ocasional,
      })
      .expect(200);

    expect(approveRes.body.estado_solicitud).toBe(
      OccasionalRequestStatus.APROBADO_COORDINACION,
    );
    expect(approveRes.body.lista_asistencia).toEqual({
      id_viaje: tripId,
      id_estudiante: occasionalId,
      estado_custodia: FsmCustodyState.NO_INICIADO,
      es_pasajero_ocasional: true,
    });

    // 4. Doble aprobación -> 409
    await request(app.getHttpServer())
      .post("/pasajeros-ocasionales/aprobar")
      .set("Authorization", coordAuth)
      .send({
        id_pasajero_ocasional: reqRes.body.id_pasajero_ocasional,
      })
      .expect(409);

    // 5. Monitora escanea el QR provisional en POST /asistencia/abordaje (Issue #8) -> 200 ABORDAJE_EXITOSO
    const monitoraAuth = `Bearer ${await makeToken(["MONITORA"], makeUuid(2088), false)}`;
    const boardRes = await request(app.getHttpServer())
      .post("/asistencia/abordaje")
      .set("Authorization", monitoraAuth)
      .send({
        id_viaje: tripId,
        qr_token: reqRes.body.qr_provisional_token,
        metodo_validacion: "QR_OCASIONAL_TEMPORAL",
        coordenadas_gps: { latitud: 4.8133, longitud: -75.6961 },
      })
      .expect(200);

    expect(boardRes.body.aprobado).toBe(true);
    expect(boardRes.body.codigo).toBe(BoardingResultCode.ABORDAJE_EXITOSO);
    expect(boardRes.body.estado_custodia).toBe(FsmCustodyState.A_BORDO_VEHICULO);
    expect(boardRes.body.total_a_bordo).toBe(1);
  });

  it("estrés HTTP concurrente: 8 acudientes compiten simultáneamente por 1 única vacante -> 1 recibe 201 y 7 reciben 422", async () => {
    const testRouteId = makeUuid(3000);
    const tripId = makeUuid(3001);
    const regularId = makeUuid(3002);

    passengersRepo.setSimulatedIoDelayMs(10);
    passengersRepo.registerTrip({
      id_viaje: tripId,
      id_ruta: testRouteId,
      id_colegio: schoolId,
      jornada: "MANANA",
      estado: TripStateEnum.PROGRAMADO,
      hora_inicio_programada: new Date("2026-11-30T06:30:00.000-05:00"),
      capacidad_nominal: 1,
    });
    passengersRepo.registerStudent({
      id_estudiante: regularId,
      id_colegio: schoolId,
      activo: true,
    });
    passengersRepo.registerRouteAssignment({
      id_estudiante: regularId,
      id_ruta: testRouteId,
      ciclo_horario: "AMBOS",
      activa: true,
    });
    passengersRepo.registerAbsence({
      id_viaje: tripId,
      id_estudiante: regularId,
      reportado_por_acudiente: makeUuid(3099),
      cupo_liberado: true,
    });

    mockNow = new Date("2026-11-30T04:00:00.000-05:00");

    const entries = await Promise.all(
      Array.from({ length: 8 }, async (_, idx) => {
        const studentId = makeUuid(3100 + idx);
        const parentUserId = makeUuid(3200 + idx);
        const parentId = makeUuid(3300 + idx);
        passengersRepo.registerStudent({
          id_estudiante: studentId,
          id_colegio: schoolId,
          activo: true,
        });
        passengersRepo.registerGuardianLink({
          id_acudiente: parentId,
          id_usuario: parentUserId,
          id_estudiante: studentId,
        });
        const auth = `Bearer ${await makeToken(["ACUDIENTE"], parentUserId, false)}`;
        return { studentId, auth };
      }),
    );

    const responses = await Promise.all(
      entries.map((entry) =>
        request(app.getHttpServer())
          .post("/pasajeros-ocasionales/solicitar")
          .set("Authorization", entry.auth)
          .send({
            id_viaje: tripId,
            id_estudiante: entry.studentId,
          }),
      ),
    );

    passengersRepo.setSimulatedIoDelayMs(0);

    const created = responses.filter((r) => r.status === 201);
    const rejected = responses.filter((r) => r.status === 422);

    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    expect(
      rejected.every(
        (r) =>
          r.body.code === "REGLAS_PASAJERO_OCASIONAL_INCUMPLIDAS" &&
          String(r.body.message).includes(
            OccasionalRejectionReason.SIN_VACANTE_POR_INASISTENCIA,
          ),
      ),
    ).toBe(true);
  });
});
