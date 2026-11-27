import {
  ForbiddenException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AesEncryptionService } from "@common/crypto/aes-encryption.service";
import { BlindIndexService } from "@common/crypto/blind-index.service";
import { CryptoVaultService } from "@common/crypto/crypto-vault.service";
import { HashService } from "@common/crypto/hash.service";
import { TripStateEnum } from "@common/enums/trip-state.enum";
import { AuditService } from "../audit/audit.service";
import { CustodyService } from "../custody/custody.service";
import { FsmCustodyState } from "../custody/domain/custody.types";
import { InMemoryCustodyRepository } from "../custody/infrastructure/in-memory-custody.repository";
import { IJudicialAlertRepository } from "../custody/judicial-alerts/domain/judicial-alert-repository.port";
import {
  JUDICIAL_BLOCKING_CODE,
  JUDICIAL_EMERGENCY_NOTIFICATION_CODE,
} from "../custody/judicial-alerts/domain/judicial-alert.types";
import { InMemoryJudicialAlertRepository } from "../custody/judicial-alerts/infrastructure/in-memory-judicial-alert.repository";
import { JudicialAlertsService } from "../custody/judicial-alerts/judicial-alerts.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AttendanceService } from "./attendance.service";
import { BoardingNotificationQueueService } from "./boarding-notification-queue.service";
import { CapacityEnforcer } from "./capacity-enforcer.service";
import { DeliveryValidationService } from "./delivery-validation.service";
import { DisembarkUseCase } from "./disembark.use-case";
import { IAttendanceRealtimePort } from "./domain/attendance-realtime.port";
import {
  OvercapacityAlertEventPayload,
  StudentBoardedEventPayload,
} from "./domain/attendance.types";
import {
  DeliveryInterceptor,
  DeliveryInterceptorChain,
  DeliveryInterceptorContext,
} from "./domain/delivery-interceptor.interface";
import {
  DisembarkOutcomeType,
  DisembarkResultCode,
  FailedDeliveryAlertEventPayload,
  JudicialAlertBlockedError,
  JudicialAlertEventPayload,
  ReceptorType,
  ReceptorUnauthorizedError,
  SchoolCustodyFinalizedEventPayload,
  StudentDisembarkedEventPayload,
  UnauthorizedReceptorAlertEventPayload,
} from "./domain/disembark.types";
import { IncidentLogger } from "./incident-logger.service";
import { InMemoryAttendanceRepository } from "./infrastructure/in-memory-attendance.repository";
import { JudicialAlertDeliveryInterceptor } from "./judicial-alert-delivery.interceptor";
import { QrTokenValidator } from "./qr-token-validator.service";

const makeUuid = (suffix: number) =>
  `018e38d9-3f00-7200-b300-${String(suffix).padStart(12, "0")}`;

const STOP_COORDS = { latitud: 4.8133, longitud: -75.6961 };
const SCHOOL_COORDS = { latitud: 4.8143, longitud: -75.6946 };

class JudicialRecordingRealtimePort implements IAttendanceRealtimePort {
  readonly boardedEvents: StudentBoardedEventPayload[] = [];
  readonly overcapacityAlerts: OvercapacityAlertEventPayload[] = [];
  readonly disembarkedEvents: StudentDisembarkedEventPayload[] = [];
  readonly failedDeliveryAlerts: FailedDeliveryAlertEventPayload[] = [];
  readonly unauthorizedReceptorAlerts: UnauthorizedReceptorAlertEventPayload[] =
    [];
  readonly judicialAlerts: JudicialAlertEventPayload[] = [];
  readonly schoolReturnCompletedEvents: SchoolCustodyFinalizedEventPayload[] =
    [];

  async emitStudentBoarded(payload: StudentBoardedEventPayload): Promise<void> {
    this.boardedEvents.push(payload);
  }
  async emitOvercapacityAlert(
    payload: OvercapacityAlertEventPayload,
  ): Promise<void> {
    this.overcapacityAlerts.push(payload);
  }
  async emitStudentDisembarked(
    payload: StudentDisembarkedEventPayload,
  ): Promise<void> {
    this.disembarkedEvents.push(payload);
  }
  async emitFailedDeliveryAlert(
    payload: FailedDeliveryAlertEventPayload,
  ): Promise<void> {
    this.failedDeliveryAlerts.push(payload);
  }
  async emitUnauthorizedReceptorAlert(
    payload: UnauthorizedReceptorAlertEventPayload,
  ): Promise<void> {
    this.unauthorizedReceptorAlerts.push(payload);
  }
  async emitJudicialAlert(payload: JudicialAlertEventPayload): Promise<void> {
    this.judicialAlerts.push(payload);
  }
  async emitSchoolCustodyFinalized(
    payload: SchoolCustodyFinalizedEventPayload,
  ): Promise<void> {
    this.schoolReturnCompletedEvents.push(payload);
  }
}

describe("Motor de Protección Preventiva contra Alertas Judiciales (Issue #10: OCP, Defensa en Profundidad, Fail-Safe)", () => {
  let hashService: HashService;
  let cryptoVault: CryptoVaultService;
  let blindIndexService: BlindIndexService;
  let auditService: AuditService;
  let notificationsService: NotificationsService;
  let custodyService: CustodyService;
  let judicialAlertRepository: InMemoryJudicialAlertRepository;
  let judicialAlertsService: JudicialAlertsService;
  let attendanceRepository: InMemoryAttendanceRepository;
  let realtimePort: JudicialRecordingRealtimePort;
  let notificationQueue: BoardingNotificationQueueService;
  let incidentLogger: IncidentLogger;
  let deliveryValidationService: DeliveryValidationService;
  let judicialInterceptor: JudicialAlertDeliveryInterceptor;
  let interceptorChain: DeliveryInterceptorChain;
  let attendanceService: AttendanceService;
  let disembarkUseCase: DisembarkUseCase;

  const schoolId = makeUuid(1);
  const routeId = makeUuid(2);
  const monitoraUserId = makeUuid(3);
  const rectoriaUserId = makeUuid(4);
  const motherGuardianId = makeUuid(51);
  const restrictedFatherGuardianId = makeUuid(52);
  const restrictedAuthorizedAdultId = makeUuid(53);

  beforeEach(() => {
    const config = new ConfigService({
      NODE_ENV: "test",
      APP_BLIND_INDEX_HMAC_KEY: Buffer.from(
        "test-hmac-key-32-bytes-issue-10!",
      ).toString("base64"),
      APP_ENCRYPTION_MASTER_KEY: Buffer.from(
        "test-aes-key-32-bytes-issue-010!",
      ).toString("base64"),
    });
    hashService = new HashService();
    blindIndexService = new BlindIndexService(config);
    cryptoVault = new CryptoVaultService(
      new AesEncryptionService(config),
      blindIndexService,
      config,
    );
    auditService = new AuditService();
    notificationsService = new NotificationsService();
    custodyService = new CustodyService(new InMemoryCustodyRepository());
    judicialAlertRepository = new InMemoryJudicialAlertRepository();
    judicialAlertsService = new JudicialAlertsService(
      judicialAlertRepository,
      cryptoVault,
      hashService,
      blindIndexService,
      auditService,
    );

    const capacityEnforcer = new CapacityEnforcer();
    attendanceRepository = new InMemoryAttendanceRepository(
      capacityEnforcer,
      custodyService,
      judicialAlertRepository,
    );
    realtimePort = new JudicialRecordingRealtimePort();
    notificationQueue = new BoardingNotificationQueueService(
      notificationsService,
    );
    incidentLogger = new IncidentLogger(
      attendanceRepository,
      realtimePort,
      auditService,
    );
    deliveryValidationService = new DeliveryValidationService(
      attendanceRepository,
      cryptoVault,
      blindIndexService,
    );
    judicialInterceptor = new JudicialAlertDeliveryInterceptor(
      attendanceRepository,
      deliveryValidationService,
      incidentLogger,
      notificationQueue,
      judicialAlertsService,
      auditService,
    );
    interceptorChain = new DeliveryInterceptorChain([judicialInterceptor]);
    attendanceService = new AttendanceService(
      attendanceRepository,
      new QrTokenValidator(hashService),
      capacityEnforcer,
      incidentLogger,
      realtimePort,
      notificationQueue,
    );
    disembarkUseCase = new DisembarkUseCase(
      attendanceRepository,
      deliveryValidationService,
      incidentLogger,
      notificationQueue,
      realtimePort,
      interceptorChain,
    );
  });

  async function seedStudentAndBoard(params: {
    tripId: string;
    studentId: string;
    jornada?: "MANANA" | "TARDE";
    includeRestrictedFatherAsGuardian?: boolean;
  }) {
    attendanceRepository.registerTrip({
      id_viaje: params.tripId,
      id_ruta: routeId,
      estado: TripStateEnum.EN_CURSO,
      jornada: params.jornada ?? "TARDE",
      capacidad_nominal: 15,
      total_a_bordo: 0,
    });

    const qrRaw = `QR-JUD-${params.studentId.slice(-4)}`;
    attendanceRepository.registerStudent({
      id_estudiante: params.studentId,
      id_colegio: schoolId,
      activo: true,
      qr_token_hash: hashService.sha256(qrRaw),
      id_acudiente_titular: motherGuardianId,
    });
    attendanceRepository.registerRouteAssignment({
      id_estudiante: params.studentId,
      id_ruta: routeId,
      ciclo_horario: "AMBOS",
      activa: true,
    });

    // Madre (acudiente segura)
    attendanceRepository.registerGuardianLink({
      id_acudiente: motherGuardianId,
      id_estudiante: params.studentId,
      nombres: "Carolina",
      apellidos: "Madre",
      documento_blind_index:
        deliveryValidationService.computeDocumentBlindIndex("52987654"),
      parentesco: "MADRE",
      es_tutor_principal: true,
      orden_notificacion: 1,
    });

    // Progenitor con cédula 79123456 (incluso si históricamente figuraba como acudiente)
    if (params.includeRestrictedFatherAsGuardian) {
      attendanceRepository.registerGuardianLink({
        id_acudiente: restrictedFatherGuardianId,
        id_estudiante: params.studentId,
        nombres: "Carlos",
        apellidos: "Progenitor",
        documento_blind_index:
          deliveryValidationService.computeDocumentBlindIndex("79123456"),
        parentesco: "PADRE",
        es_tutor_principal: false,
        orden_notificacion: 2,
      });
    }

    // El abordaje NO se bloquea aunque exista alerta judicial activa (el niño sube a salvo)
    const boarded = await attendanceService.registerBoarding({
      id_viaje: params.tripId,
      qr_token: qrRaw,
      coordenadas_gps: SCHOOL_COORDS,
      registrado_por_usuario: monitoraUserId,
    });
    expect(boarded.aprobado).toBe(true);
    expect(boarded.estado_custodia).toBe(FsmCustodyState.A_BORDO_VEHICULO);
  }

  it("Criterio de Aceptación #10: progenitor 79123456 bloqueado con ALERTA_JUDICIAL_BLOQUEANTE, niño queda en el bus, SMS de emergencia SOLO a la madre, alerta a Policía de Infancia y Coordinación, sin bloquear abordaje", async () => {
    const tripId = makeUuid(101);
    const studentId = makeUuid(1001);

    // 1. Coordinación/Rectoría registra la alerta judicial ANTES del viaje
    const alert = await judicialAlertsService.createAlert(
      {
        id_estudiante: studentId,
        juzgado_emisor: "Comisaría Primera de Familia de Pereira",
        radicado_medida: "CFP-2026-79123456",
        individuo_restringido_nombre: "Carlos Progenitor",
        individuo_restringido_documento: "79123456",
        orden_judicial_resumen:
          "Prohibición judicial de entrega del menor al progenitor.",
      },
      rectoriaUserId,
    );

    // 2. El menor aborda a salvo el vehículo (NO bloqueado por la alerta judicial)
    await seedStudentAndBoard({
      tripId,
      studentId,
      includeRestrictedFatherAsGuardian: true,
    });

    // 3. El progenitor con cédula 79123456 intenta retirar al menor en la parada
    let caughtError: unknown;
    try {
      await disembarkUseCase.executeDisembark({
        id_viaje: tripId,
        id_estudiante: studentId,
        tipo_receptor: ReceptorType.ACUDIENTE,
        documento_receptor: "79.123.456",
        coordenadas_gps: STOP_COORDS,
        registrado_por_usuario: monitoraUserId,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ForbiddenException);
    const responseBody = (
      caughtError as ForbiddenException
    ).getResponse() as Record<string, unknown>;
    expect(responseBody.code).toBe(JUDICIAL_BLOCKING_CODE);
    expect(responseBody.error).toBe(JUDICIAL_BLOCKING_CODE);
    expect(responseBody.id_alerta).toBe(alert.id_alerta);
    expect(responseBody.radicado_medida).toBe("CFP-2026-79123456");
    expect(responseBody.menor_permanece_a_bordo).toBe(true);
    expect(responseBody.notificaciones_sms_emergencia).toBe(1);
    expect(responseBody.alerta_policia_infancia_enviada).toBe(true);

    // 4. El niño permanece a bordo en el bus, sin entrega y sin decrementar aforo
    const occupancy = await attendanceRepository.getTripOccupancy(tripId);
    expect(occupancy?.total_a_bordo).toBe(1);
    const custody = await custodyService.getStudentTripCustody(
      tripId,
      studentId,
    );
    expect(custody.estado_custodia).toBe(FsmCustodyState.A_BORDO_VEHICULO);
    expect(await attendanceRepository.listStudentDeliveries(tripId)).toHaveLength(
      0,
    );

    // 5. Acta automática en `incidente` (severidad CRITICO)
    const incidents = await attendanceRepository.listTripIncidents(tripId);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].tipo_incidente).toBe("ALERTA_JUDICIAL_DETECTADA");
    expect(incidents[0].severidad).toBe("CRITICO");
    expect(incidents[0].descripcion).toContain("CFP-2026-79123456");

    // 6. SMS de emergencia (`ALERTA_JUDICIAL_ACTIVADA`) despachado SOLO a la madre,
    //    NUNCA al progenitor restringido, + alerta institucional a Policía de Infancia
    const emergencyDispatches = notificationsService.listEmergencyDispatches();
    const smsDispatches = emergencyDispatches.filter((d) => d.canal === "SMS");
    const policeDispatches = emergencyDispatches.filter(
      (d) => d.canal === "POLICIA_INFANCIA_ADOLESCENCIA",
    );

    expect(smsDispatches).toHaveLength(1);
    expect(smsDispatches[0].destinatario).toBe(motherGuardianId);
    expect(smsDispatches[0].tipo_notificacion).toBe(
      JUDICIAL_EMERGENCY_NOTIFICATION_CODE,
    );
    expect(smsDispatches[0].silenciable).toBe(false);
    expect(smsDispatches[0].prioridad).toBe("MAXIMA");

    expect(policeDispatches).toHaveLength(1);
    expect(policeDispatches[0].destinatario).toBe(
      "POLICIA_INFANCIA_Y_ADOLESCENCIA_INSTITUCIONAL",
    );
    expect(policeDispatches[0].datos_adicionales.radicado_medida).toBe(
      "CFP-2026-79123456",
    );

    // 7. Alerta en tiempo real a Coordinación
    expect(realtimePort.judicialAlerts).toHaveLength(1);
    expect(realtimePort.judicialAlerts[0].codigo).toBe(JUDICIAL_BLOCKING_CODE);
    expect(realtimePort.judicialAlerts[0].alerta_policia_infancia_enviada).toBe(
      true,
    );

    // 8. Posteriormente, la madre (no restringida) SÍ puede recibir al menor con normalidad
    const motherDelivery = await disembarkUseCase.executeDisembark({
      id_viaje: tripId,
      id_estudiante: studentId,
      tipo_receptor: ReceptorType.ACUDIENTE,
      documento_receptor: "52987654",
      coordenadas_gps: STOP_COORDS,
      registrado_por_usuario: monitoraUserId,
    });
    expect(motherDelivery.aprobado).toBe(true);
    expect(motherDelivery.codigo).toBe(DisembarkResultCode.DESCENSO_EXITOSO);
    expect(motherDelivery.total_a_bordo).toBe(0);
  });

  it("Defensa en Profundidad + DoD: imposibilidad matemática de autorizar la entrega incluso llamando al repositorio directamente o intentando como ADULTO_AUTORIZADO", async () => {
    const tripId = makeUuid(102);
    const studentId = makeUuid(1002);

    const restrictedHash =
      judicialAlertsService.computeRestrictedDocumentHash("79123456");

    await judicialAlertsService.createAlert(
      {
        id_estudiante: studentId,
        juzgado_emisor: "Juzgado 1 de Familia",
        radicado_medida: "JF1-2026-DEFENSE",
        individuo_restringido_nombre: "Individuo Restringido",
        individuo_restringido_documento: "79123456",
        orden_judicial_resumen: "Bloqueo absoluto de entrega.",
      },
      rectoriaUserId,
    );

    await seedStudentAndBoard({
      tripId,
      studentId,
      includeRestrictedFatherAsGuardian: true,
    });

    // Incluso si por error de datos también figuraba como ADULTO_AUTORIZADO vigente
    attendanceRepository.registerAuthorizedAdultLink({
      id_autorizado: restrictedAuthorizedAdultId,
      id_estudiante: studentId,
      nombres: "Individuo",
      apellidos: "Restringido",
      documento_blind_index: restrictedHash,
      parentesco: "FAMILIAR",
      prioridad_retiro: 1,
      adulto_activo: true,
      autorizacion_activa: true,
      autorizado_hasta: new Date(Date.now() + 86_400_000),
      expediente_revocado: false,
    });

    // Capa 1 (Aplicación / Interceptor OCP) bloquea como ADULTO_AUTORIZADO
    await expect(
      disembarkUseCase.executeDisembark({
        id_viaje: tripId,
        id_estudiante: studentId,
        tipo_receptor: ReceptorType.ADULTO_AUTORIZADO,
        documento_blind_index: restrictedHash,
        coordenadas_gps: STOP_COORDS,
        registrado_por_usuario: monitoraUserId,
      }),
    ).rejects.toThrow(ForbiddenException);

    // Capa 2 (Repositorio / Persistencia): llamada directa sin pasar por DisembarkUseCase también bloquea
    await expect(
      attendanceRepository.registerAtomicDisembark({
        id_viaje: tripId,
        id_estudiante: studentId,
        resultado_entrega: DisembarkOutcomeType.ENTREGADO_EXITOSO,
        tipo_receptor: ReceptorType.ACUDIENTE,
        receptor_documento_blind_index: restrictedHash,
        id_receptor: restrictedFatherGuardianId,
        metodo_validacion: "VERIFICACION_VISUAL_PARADA",
        coordenadas: STOP_COORDS,
        registrado_por_usuario: monitoraUserId,
        foto_evidencia_url: null,
        observaciones_fallido: null,
        idempotency_key: null,
        sincronizado_offline: false,
      }),
    ).rejects.toThrow(JudicialAlertBlockedError);

    expect(
      (await attendanceRepository.getTripOccupancy(tripId))?.total_a_bordo,
    ).toBe(1);
    expect(await attendanceRepository.listStudentDeliveries(tripId)).toHaveLength(
      0,
    );
  });

  it("Principio OCP: permite incorporar nuevos DeliveryInterceptor cautelares en la cadena sin modificar DisembarkUseCase", async () => {
    const tripId = makeUuid(103);
    const studentId = makeUuid(1003);
    await seedStudentAndBoard({ tripId, studentId });

    const executionOrder: string[] = [];

    const customPrecautionaryInterceptor: DeliveryInterceptor = {
      name: "CustomPrecautionaryRuleInterceptor",
      priority: 10,
      async intercept(ctx: DeliveryInterceptorContext): Promise<void> {
        executionOrder.push(this.name);
        if (ctx.documento_receptor === "52987654") {
          throw new ReceptorUnauthorizedError(
            ctx.id_estudiante,
            "Regla cautelar adicional activada vía OCP.",
          );
        }
      },
    };

    const telemetryInterceptor: DeliveryInterceptor = {
      name: "PreCheckObserverInterceptor",
      priority: 0,
      async intercept(): Promise<void> {
        executionOrder.push(this.name);
      },
    };

    interceptorChain.registerInterceptor(customPrecautionaryInterceptor);
    interceptorChain.registerInterceptor(telemetryInterceptor);

    await expect(
      disembarkUseCase.executeDisembark({
        id_viaje: tripId,
        id_estudiante: studentId,
        tipo_receptor: ReceptorType.ACUDIENTE,
        documento_receptor: "52987654",
        coordenadas_gps: STOP_COORDS,
        registrado_por_usuario: monitoraUserId,
      }),
    ).rejects.toThrow(ForbiddenException);

    // Se ejecutaron estrictamente en orden de prioridad: 0 -> 1 (Judicial) -> 10 (Custom)
    expect(executionOrder).toEqual([
      "PreCheckObserverInterceptor",
      "CustomPrecautionaryRuleInterceptor",
    ]);
    expect(
      (await attendanceRepository.getTripOccupancy(tripId))?.total_a_bordo,
    ).toBe(1);
  });

  it("Principio Fail-Safe (RNF-01): ante un error técnico del motor judicial bloquea la entrega (503) y registra incidente auditable", async () => {
    const tripId = makeUuid(104);
    const studentId = makeUuid(1004);
    await seedStudentAndBoard({ tripId, studentId });

    const failingJudicialRepo: IJudicialAlertRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      listByStudent: jest.fn().mockResolvedValue([]),
      deactivateSoft: jest.fn(),
      findActiveMatchByBlindIndex: jest
        .fn()
        .mockRejectedValue(new Error("timeout consultando alerta_judicial")),
    };

    const failingJudicialService = new JudicialAlertsService(
      failingJudicialRepo,
      cryptoVault,
      hashService,
      blindIndexService,
      auditService,
    );
    const failingInterceptor = new JudicialAlertDeliveryInterceptor(
      attendanceRepository,
      deliveryValidationService,
      incidentLogger,
      notificationQueue,
      failingJudicialService,
      auditService,
    );
    const failSafeUseCase = new DisembarkUseCase(
      attendanceRepository,
      deliveryValidationService,
      incidentLogger,
      notificationQueue,
      realtimePort,
      new DeliveryInterceptorChain([failingInterceptor]),
    );

    await expect(
      failSafeUseCase.executeDisembark({
        id_viaje: tripId,
        id_estudiante: studentId,
        tipo_receptor: ReceptorType.ACUDIENTE,
        documento_receptor: "52987654",
        coordenadas_gps: STOP_COORDS,
        registrado_por_usuario: monitoraUserId,
      }),
    ).rejects.toThrow(ServiceUnavailableException);

    // Menor sigue seguro a bordo y quedó incidente CRITICO auditable
    expect(
      (await attendanceRepository.getTripOccupancy(tripId))?.total_a_bordo,
    ).toBe(1);
    const incidents = await attendanceRepository.listTripIncidents(tripId);
    expect(
      incidents.some(
        (i) =>
          i.tipo_incidente === "ERROR_MOTOR_PROTECCION_JUDICIAL" &&
          i.severidad === "CRITICO",
      ),
    ).toBe(true);
  });
});
