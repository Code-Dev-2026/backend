import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { io as createSocketClient, Socket } from "socket.io-client";
import * as request from "supertest";
import { CryptoModule } from "@common/crypto/crypto.module";
import { HashService } from "@common/crypto/hash.service";
import { TripStateEnum } from "@common/enums/trip-state.enum";
import { AllExceptionsFilter } from "@common/filters/all-exceptions.filter";
import { AttendanceModule } from "../../attendance/attendance.module";
import { DeliveryValidationService } from "../../attendance/delivery-validation.service";
import { ATTENDANCE_REPOSITORY } from "../../attendance/domain/attendance-repository.port";
import {
  DisembarkResultCode,
  JudicialAlertEventPayload,
  ReceptorType,
} from "../../attendance/domain/disembark.types";
import { InMemoryAttendanceRepository } from "../../attendance/infrastructure/in-memory-attendance.repository";
import { AuthModule } from "../../auth/auth.module";
import { TokenService } from "../../auth/token.service";
import { NotificationsService } from "../../notifications/notifications.service";
import { CustodyModule } from "../custody.module";
import { JUDICIAL_BLOCKING_CODE } from "./domain/judicial-alert.types";

const makeUuid = (suffix: number) =>
  `018e38d9-3f00-7200-a200-${String(suffix).padStart(12, "0")}`;

const STOP_COORDS = { latitud: 4.8133, longitud: -75.6961 };
const SCHOOL_COORDS = { latitud: 4.8143, longitud: -75.6946 };

describe("HTTP + RBAC + Socket.IO — Motor de Alertas Judiciales Preventivas (Issue #10)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let tokens: TokenService;
  let attendanceRepository: InMemoryAttendanceRepository;
  let hashService: HashService;
  let validationService: DeliveryValidationService;
  let notificationsService: NotificationsService;

  const schoolId = makeUuid(1);
  const routeId = makeUuid(2);
  const motherId = makeUuid(3);
  const fatherId = makeUuid(4);

  const makeToken = (roles: string[], userId = makeUuid(99), mfa = true) =>
    tokens.signAccessToken(
      {
        id_usuario: userId,
        email: "coordinacion@caminoseguro.co",
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
                "http-hmac-key-32-bytes-issue-10!",
              ).toString("base64"),
              APP_ENCRYPTION_MASTER_KEY: Buffer.from(
                "http-aes-key-32-bytes-issue-010!",
              ).toString("base64"),
            }),
          ],
        }),
        CryptoModule,
        AuthModule,
        CustodyModule,
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
    attendanceRepository = moduleRef.get(ATTENDANCE_REPOSITORY);
    hashService = moduleRef.get(HashService);
    validationService = moduleRef.get(DeliveryValidationService);
    notificationsService = moduleRef.get(NotificationsService);
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

  it("exige JWT (401), RBAC estricto y MFA en gestión de alertas judiciales (403) y valida DTO (400)", async () => {
    await request(app.getHttpServer())
      .post("/custody/judicial-alerts")
      .send({})
      .expect(401);

    const monitoraAuth = `Bearer ${await makeToken(["MONITORA"], makeUuid(501), false)}`;
    const parentAuth = `Bearer ${await makeToken(["ACUDIENTE"], makeUuid(502), false)}`;
    const coordNoMfa = `Bearer ${await makeToken(["COORDINADORA_CONVIVENCIA"], makeUuid(503), false)}`;
    const coordMfa = `Bearer ${await makeToken(["COORDINADORA_CONVIVENCIA"], makeUuid(503), true)}`;

    const validAlertBody = {
      id_estudiante: makeUuid(1001),
      juzgado_emisor: "Comisaría Primera de Familia",
      radicado_medida: "CFP-RBAC-001",
      individuo_restringido_nombre: "Progenitor Restringido",
      individuo_restringido_documento: "79123456",
      orden_judicial_resumen: "Prohibición de retiro.",
    };

    // MONITORA y ACUDIENTE no pueden registrar alertas judiciales
    await request(app.getHttpServer())
      .post("/custody/judicial-alerts")
      .set("Authorization", monitoraAuth)
      .send(validAlertBody)
      .expect(403);

    await request(app.getHttpServer())
      .post("/custody/judicial-alerts")
      .set("Authorization", parentAuth)
      .send(validAlertBody)
      .expect(403);

    // COORDINADORA sin MFA es rechazada (AppMfaGuard -> 401 Unauthorized)
    await request(app.getHttpServer())
      .post("/custody/judicial-alerts")
      .set("Authorization", coordNoMfa)
      .send(validAlertBody)
      .expect(401);

    // Payload inválido -> 400
    await request(app.getHttpServer())
      .post("/custody/judicial-alerts")
      .set("Authorization", coordMfa)
      .send({ id_estudiante: "no-uuid" })
      .expect(400);
  });

  it("flujo HTTP + Socket.IO completo del Criterio de Aceptación #10: registro por Coordinación -> abordaje permitido -> intento de progenitor 79123456 retorna 403 ALERTA_JUDICIAL_BLOQUEANTE + WS + SMS a madre + Policía -> entrega posterior a madre 200", async () => {
    const tripId = makeUuid(201);
    const studentId = makeUuid(2001);
    const qrRaw = "QR-HTTP-JUD-2001";

    const coordAuth = `Bearer ${await makeToken(["COORDINADORA_CONVIVENCIA"], makeUuid(601), true)}`;
    const monitoraAuth = `Bearer ${await makeToken(["MONITORA"], makeUuid(602), false)}`;

    // 1. Coordinación registra medida cautelar contra cédula 79123456
    const createdRes = await request(app.getHttpServer())
      .post("/custody/judicial-alerts")
      .set("Authorization", coordAuth)
      .send({
        id_estudiante: studentId,
        juzgado_emisor: "Comisaría Primera de Familia de Pereira",
        radicado_medida: "CFP-2026-HTTP-79123456",
        individuo_restringido_nombre: "Progenitor Sancionado",
        individuo_restringido_documento: "79123456",
        orden_judicial_resumen:
          "Prohibición absoluta de entrega al progenitor con cédula 79123456.",
      })
      .expect(201);

    expect(createdRes.headers["cache-control"]).toBe("no-store");
    expect(createdRes.body.activa).toBe(true);
    expect(createdRes.body.documento_restringido_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(createdRes.body.individuo_restringido_documento_enmascarado).toBe(
      "****3456",
    );

    // 2. Preparar viaje, estudiante, madre y progenitor restringido en el viaje
    attendanceRepository.registerTrip({
      id_viaje: tripId,
      id_ruta: routeId,
      estado: TripStateEnum.EN_CURSO,
      jornada: "TARDE",
      capacidad_nominal: 15,
      total_a_bordo: 0,
    });
    attendanceRepository.registerStudent({
      id_estudiante: studentId,
      id_colegio: schoolId,
      activo: true,
      qr_token_hash: hashService.sha256(qrRaw),
      id_acudiente_titular: motherId,
    });
    attendanceRepository.registerRouteAssignment({
      id_estudiante: studentId,
      id_ruta: routeId,
      ciclo_horario: "AMBOS",
      activa: true,
    });
    attendanceRepository.registerGuardianLink({
      id_acudiente: motherId,
      id_estudiante: studentId,
      nombres: "Ana",
      apellidos: "Madre",
      documento_blind_index:
        validationService.computeDocumentBlindIndex("52111222"),
      parentesco: "MADRE",
      es_tutor_principal: true,
      orden_notificacion: 1,
    });
    attendanceRepository.registerGuardianLink({
      id_acudiente: fatherId,
      id_estudiante: studentId,
      nombres: "Progenitor",
      apellidos: "Sancionado",
      documento_blind_index:
        validationService.computeDocumentBlindIndex("79123456"),
      parentesco: "PADRE",
      es_tutor_principal: false,
      orden_notificacion: 2,
    });

    // 3. Abordaje NO se bloquea por alerta judicial
    const boardRes = await request(app.getHttpServer())
      .post("/asistencia/abordaje")
      .set("Authorization", monitoraAuth)
      .send({
        id_viaje: tripId,
        qr_token: qrRaw,
        coordenadas_gps: SCHOOL_COORDS,
      })
      .expect(200);
    expect(boardRes.body.aprobado).toBe(true);
    expect(boardRes.body.total_a_bordo).toBe(1);

    // 4. Consulta determinista previa por monitora -> ALERTA_JUDICIAL_BLOQUEANTE sin exponer PII
    const verifyRes = await request(app.getHttpServer())
      .post("/custody/judicial-alerts/verify")
      .set("Authorization", monitoraAuth)
      .send({
        id_estudiante: studentId,
        documento_receptor: "79123456",
      })
      .expect(200);
    expect(verifyRes.body.bloqueada).toBe(true);
    expect(verifyRes.body.codigo).toBe(JUDICIAL_BLOCKING_CODE);
    expect(verifyRes.body.orden_judicial_resumen).toBeUndefined();

    // 5. Escuchar evento Socket.IO `coordination:judicial_alert` en la sala `coordinacion`
    const socket = await connectSocket();
    const receivedJudicialAlerts: JudicialAlertEventPayload[] = [];
    socket.on(
      "coordination:judicial_alert",
      (payload: JudicialAlertEventPayload) => {
        if (payload.id_viaje === tripId) {
          receivedJudicialAlerts.push(payload);
        }
      },
    );
    await new Promise<void>((resolve) => {
      socket.emit("subscribe:coordination", {}, () => resolve());
    });

    try {
      // 6. Progenitor 79123456 intenta retirar al menor -> 403 ALERTA_JUDICIAL_BLOQUEANTE
      const blockedRes = await request(app.getHttpServer())
        .post("/asistencia/descenso")
        .set("Authorization", monitoraAuth)
        .send({
          id_viaje: tripId,
          id_estudiante: studentId,
          tipo_receptor: ReceptorType.ACUDIENTE,
          documento_receptor: "79123456",
          coordenadas_gps: STOP_COORDS,
        })
        .expect(403);

      expect(blockedRes.body.code).toBe(JUDICIAL_BLOCKING_CODE);
      expect(blockedRes.body.error).toBe(JUDICIAL_BLOCKING_CODE);
      expect(blockedRes.body.message).toContain(JUDICIAL_BLOCKING_CODE);

      // Menor permanece a bordo (total_a_bordo sigue en 1)
      expect(
        (await attendanceRepository.getTripOccupancy(tripId))?.total_a_bordo,
      ).toBe(1);

      // Verificar SMS de emergencia a madre y alerta a Policía de Infancia
      const dispatches = notificationsService
        .listEmergencyDispatches()
        .filter((d) => d.id_viaje === tripId);
      expect(
        dispatches.some(
          (d) => d.canal === "SMS" && d.destinatario === motherId,
        ),
      ).toBe(true);
      expect(
        dispatches.some(
          (d) => d.canal === "SMS" && d.destinatario === fatherId,
        ),
      ).toBe(false);
      expect(
        dispatches.some(
          (d) => d.canal === "POLICIA_INFANCIA_ADOLESCENCIA",
        ),
      ).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(receivedJudicialAlerts).toHaveLength(1);
      expect(receivedJudicialAlerts[0].codigo).toBe(JUDICIAL_BLOCKING_CODE);
      expect(receivedJudicialAlerts[0].alerta_policia_infancia_enviada).toBe(
        true,
      );

      // 7. Madre (no restringida) retira al menor con éxito -> 200 DESCENSO_EXITOSO
      const okRes = await request(app.getHttpServer())
        .post("/asistencia/descenso")
        .set("Authorization", monitoraAuth)
        .send({
          id_viaje: tripId,
          id_estudiante: studentId,
          tipo_receptor: ReceptorType.ACUDIENTE,
          documento_receptor: "52111222",
          coordenadas_gps: STOP_COORDS,
        })
        .expect(200);

      expect(okRes.body.aprobado).toBe(true);
      expect(okRes.body.codigo).toBe(DisembarkResultCode.DESCENSO_EXITOSO);
      expect(okRes.body.total_a_bordo).toBe(0);

      // 8. Coordinación consulta y luego desactiva la alerta (soft-delete)
      const listRes = await request(app.getHttpServer())
        .get(`/custody/judicial-alerts/students/${studentId}`)
        .set("Authorization", coordAuth)
        .expect(200);
      expect(listRes.body).toHaveLength(1);

      const deactRes = await request(app.getHttpServer())
        .patch(`/custody/judicial-alerts/${createdRes.body.id_alerta}/deactivate`)
        .set("Authorization", coordAuth)
        .send({ autorizado_excepcion_por: "Auto de levantamiento 101" })
        .expect(200);
      expect(deactRes.body.activa).toBe(false);
      expect(deactRes.body.eliminado_soft).toBe(true);
    } finally {
      socket.disconnect();
    }
  });
});
