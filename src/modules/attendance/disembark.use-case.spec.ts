import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
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
  DisembarkOutcomeType,
  DisembarkResultCode,
  FailedDeliveryAlertEventPayload,
  ReceptorType,
  SchoolCustodyFinalizedEventPayload,
  StudentDisembarkedEventPayload,
  UnauthorizedReceptorAlertEventPayload,
} from "./domain/disembark.types";
import { IncidentLogger } from "./incident-logger.service";
import { InMemoryAttendanceRepository } from "./infrastructure/in-memory-attendance.repository";
import { QrTokenValidator } from "./qr-token-validator.service";

const makeUuid = (suffix: number) =>
  `018e38d9-3f00-7200-b100-${String(suffix).padStart(12, "0")}`;

const PEREIRA_HOME_COORDS = { latitud: 4.8133, longitud: -75.6961 };
const SAN_BENITO_SCHOOL_COORDS = { latitud: 4.8143, longitud: -75.6946 };

class FullRecordingRealtimePort implements IAttendanceRealtimePort {
  readonly boardedEvents: StudentBoardedEventPayload[] = [];
  readonly overcapacityAlerts: OvercapacityAlertEventPayload[] = [];
  readonly disembarkedEvents: StudentDisembarkedEventPayload[] = [];
  readonly failedDeliveryAlerts: FailedDeliveryAlertEventPayload[] = [];
  readonly unauthorizedReceptorAlerts: UnauthorizedReceptorAlertEventPayload[] =
    [];
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

  async emitSchoolCustodyFinalized(
    payload: SchoolCustodyFinalizedEventPayload,
  ): Promise<void> {
    this.schoolReturnCompletedEvents.push(payload);
  }
}

describe("DisembarkUseCase (Issue #9: Desembarque seguro, receptores, retorno a sede y cierre formal)", () => {
  let hashService: HashService;
  let cryptoVault: CryptoVaultService;
  let blindIndexService: BlindIndexService;
  let custodyRepository: InMemoryCustodyRepository;
  let custodyService: CustodyService;
  let repository: InMemoryAttendanceRepository;
  let realtimePort: FullRecordingRealtimePort;
  let notificationQueue: BoardingNotificationQueueService;
  let incidentLogger: IncidentLogger;
  let attendanceService: AttendanceService;
  let deliveryValidationService: DeliveryValidationService;
  let useCase: DisembarkUseCase;

  const schoolId = makeUuid(10);
  const routeId = makeUuid(20);
  const monitoraUserId = makeUuid(30);
  const coordinatorUserId = makeUuid(31);
  const coordinatorId = makeUuid(40);
  const guardian1Id = makeUuid(51);
  const guardian2Id = makeUuid(52);
  const authValidId = makeUuid(61);
  const authExpiredId = makeUuid(62);
  const authRevokedId = makeUuid(63);

  beforeEach(() => {
    const config = new ConfigService({
      NODE_ENV: "test",
      APP_BLIND_INDEX_HMAC_KEY: Buffer.from(
        "test-hmac-key-32-bytes-issue-09!",
      ).toString("base64"),
      APP_ENCRYPTION_MASTER_KEY: Buffer.from(
        "test-aes-key-32-bytes-issue-009!",
      ).toString("base64"),
    });
    hashService = new HashService();
    blindIndexService = new BlindIndexService(config);
    cryptoVault = new CryptoVaultService(
      new AesEncryptionService(config),
      blindIndexService,
      config,
    );
    const capacityEnforcer = new CapacityEnforcer();
    custodyRepository = new InMemoryCustodyRepository();
    custodyService = new CustodyService(custodyRepository);
    repository = new InMemoryAttendanceRepository(
      capacityEnforcer,
      custodyService,
    );
    realtimePort = new FullRecordingRealtimePort();
    notificationQueue = new BoardingNotificationQueueService(
      new NotificationsService(),
    );
    incidentLogger = new IncidentLogger(
      repository,
      realtimePort,
      new AuditService(),
    );
    attendanceService = new AttendanceService(
      repository,
      new QrTokenValidator(hashService),
      capacityEnforcer,
      incidentLogger,
      realtimePort,
      notificationQueue,
    );
    deliveryValidationService = new DeliveryValidationService(
      repository,
      cryptoVault,
      blindIndexService,
    );
    useCase = new DisembarkUseCase(
      repository,
      deliveryValidationService,
      incidentLogger,
      notificationQueue,
      realtimePort,
    );

    repository.registerSchoolCoordinator({
      id_coordinador: coordinatorId,
      id_colegio: schoolId,
      nombres: "Clara",
      apellidos: "Rectoría",
      cargo: "Coordinadora de Convivencia",
    });
  });

  async function seedBoardedTrip(params: {
    tripId: string;
    jornada: "MANANA" | "TARDE";
    studentIds: string[];
    capacity?: number;
  }) {
    repository.registerTrip({
      id_viaje: params.tripId,
      id_ruta: routeId,
      estado: TripStateEnum.EN_CURSO,
      jornada: params.jornada,
      capacidad_nominal: params.capacity ?? 15,
      total_a_bordo: 0,
    });

    for (let i = 0; i < params.studentIds.length; i++) {
      const id = params.studentIds[i];
      const qrRaw = `QR-DIS-${params.tripId.slice(-4)}-${i + 1}`;
      repository.registerStudent({
        id_estudiante: id,
        id_colegio: schoolId,
        activo: true,
        qr_token_hash: hashService.sha256(qrRaw),
        id_acudiente_titular: guardian1Id,
      });
      repository.registerRouteAssignment({
        id_estudiante: id,
        id_ruta: routeId,
        ciclo_horario: "AMBOS",
        activa: true,
      });
      repository.registerGuardianLink({
        id_acudiente: guardian1Id,
        id_estudiante: id,
        nombres: "Laura",
        apellidos: "Acudiente Principal",
        documento_blind_index:
          deliveryValidationService.computeDocumentBlindIndex("1088100200"),
        parentesco: "MADRE",
        es_tutor_principal: true,
        orden_notificacion: 1,
      });
      repository.registerGuardianLink({
        id_acudiente: guardian2Id,
        id_estudiante: id,
        nombres: "Pedro",
        apellidos: "Acudiente Secundario",
        documento_blind_index:
          deliveryValidationService.computeDocumentBlindIndex("1088100201"),
        parentesco: "PADRE",
        es_tutor_principal: false,
        orden_notificacion: 2,
      });

      const boarded = await attendanceService.registerBoarding({
        id_viaje: params.tripId,
        qr_token: qrRaw,
        coordenadas_gps: SAN_BENITO_SCHOOL_COORDS,
        registrado_por_usuario: monitoraUserId,
      });
      expect(boarded.aprobado).toBe(true);
    }
  }

  it("Criterio de Aceptación #9 + DoD: no-entrega en domicilio -> RETORNO_SEDE_POR_FALLA_ENTREGA, sin decrementar total_a_bordo, incidente CRITICO, alertas a acudientes y coordinación, bloqueo de cierre y cierre formal en sede", async () => {
    const tripId = makeUuid(101);
    const studentId = makeUuid(1001);
    await seedBoardedTrip({
      tripId,
      jornada: "TARDE",
      studentIds: [studentId],
    });

    // 1. Monitora reporta no-entrega en domicilio (ningún adulto autorizado comparece)
    const failedRes = await useCase.executeDisembark({
      id_viaje: tripId,
      id_estudiante: studentId,
      resultado_entrega: DisembarkOutcomeType.DESEMBARQUE_FALLIDO_RETORNO,
      coordenadas_gps: PEREIRA_HOME_COORDS,
      observaciones_fallido:
        "Ningún adulto autorizado compareció en el domicilio tras tiempo de espera reglamentario.",
      registrado_por_usuario: monitoraUserId,
    });

    expect(failedRes.aprobado).toBe(false);
    expect(failedRes.codigo).toBe(
      DisembarkResultCode.DESEMBARQUE_FALLIDO_RETORNO,
    );
    expect(failedRes.estado_entrega).toBe(
      DisembarkOutcomeType.DESEMBARQUE_FALLIDO_RETORNO,
    );
    expect(failedRes.estado_custodia).toBe(
      FsmCustodyState.RETORNO_SEDE_POR_FALLA_ENTREGA,
    );
    // CRÍTICO: el menor continúa contabilizado a bordo del vehículo
    expect(failedRes.total_a_bordo).toBe(1);
    expect(failedRes.id_asistencia).toBeNull();
    expect(failedRes.id_incidente).toBeTruthy();
    expect(failedRes.alerta_coordinacion_emitida).toBe(true);
    // Alerta inmediata a TODOS los acudientes (2 vinculados)
    expect(failedRes.notificaciones_acudientes_encoladas).toBe(2);

    const occupancyAfterFail = await repository.getTripOccupancy(tripId);
    expect(occupancyAfterFail?.total_a_bordo).toBe(1);

    const incidents = await repository.listTripIncidents(tripId);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].tipo_incidente).toBe("DESEMBARQUE_FALLIDO_RETORNO");
    expect(incidents[0].severidad).toBe("CRITICO");

    expect(realtimePort.failedDeliveryAlerts).toHaveLength(1);
    expect(realtimePort.failedDeliveryAlerts[0].id_incidente).toBe(
      failedRes.id_incidente,
    );

    // El viaje NO puede cerrarse mientras el menor esté en RETORNO_SEDE_POR_FALLA_ENTREGA
    await expect(custodyService.finalizeTrip(tripId)).rejects.toThrow(
      ConflictException,
    );

    // 2. Recepción formal en sede escolar (/asistencia/custodia/finalizar-sede)
    const finalized = await useCase.finalizeSchoolCustody({
      id_viaje: tripId,
      id_estudiante: studentId,
      recibido_por_coordinador: coordinatorId,
      coordenadas_gps: SAN_BENITO_SCHOOL_COORDS,
      observaciones: "Recibido en coordinación sin novedad.",
      registrado_por_usuario: coordinatorUserId,
    });

    expect(finalized.finalizado).toBe(true);
    expect(finalized.codigo).toBe(DisembarkResultCode.CUSTODIA_SEDE_FINALIZADA);
    expect(finalized.estado_custodia).toBe(FsmCustodyState.EN_COLEGIO);
    // Ahora SÍ se decrementa total_a_bordo
    expect(finalized.total_a_bordo).toBe(0);
    expect(finalized.id_entrega).toBe(failedRes.id_entrega);
    expect(finalized.id_acta).toBeTruthy();
    expect(finalized.firma_digital_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(finalized.notificaciones_acudientes_encoladas).toBe(2);
    expect(realtimePort.schoolReturnCompletedEvents).toHaveLength(1);

    const acta = await repository.getCustodyActaByDelivery(
      failedRes.id_entrega,
    );
    expect(acta?.id_acta).toBe(finalized.id_acta);
    expect(acta?.recibido_por_coordinador).toBe(coordinatorId);

    // Integridad WORM SHA-256 intacta (NO_INICIADO -> EN_ESPERA -> A_BORDO -> RETORNO_SEDE -> EN_COLEGIO)
    const integrity = await custodyService.verifyWormChainIntegrity();
    expect(integrity.cadena_integra).toBe(true);
    expect(integrity.total_verificados).toBe(4);

    // Ahora el viaje SÍ puede finalizarse
    const closedTrip = await custodyService.finalizeTrip(tripId);
    expect(closedTrip.estado).toBe(TripStateEnum.FINALIZADO);

    await notificationQueue.flushPendingDispatches();
  });

  it("entrega exitosa a ACUDIENTE, ADULTO_AUTORIZADO vigente y SEDE_EDUCATIVA (mañana), decrementando cupo y encadenando WORM", async () => {
    // 1. Recorrido MAÑANA -> SEDE_EDUCATIVA
    const morningTrip = makeUuid(102);
    const morningStudent = makeUuid(1002);
    await seedBoardedTrip({
      tripId: morningTrip,
      jornada: "MANANA",
      studentIds: [morningStudent],
    });

    const schoolRes = await useCase.executeDisembark({
      id_viaje: morningTrip,
      id_estudiante: morningStudent,
      tipo_receptor: ReceptorType.SEDE_EDUCATIVA,
      coordenadas_gps: SAN_BENITO_SCHOOL_COORDS,
      registrado_por_usuario: monitoraUserId,
    });
    expect(schoolRes.aprobado).toBe(true);
    expect(schoolRes.codigo).toBe(DisembarkResultCode.DESCENSO_EXITOSO);
    expect(schoolRes.estado_custodia).toBe(FsmCustodyState.EN_COLEGIO);
    expect(schoolRes.total_a_bordo).toBe(0);
    expect(schoolRes.tipo_receptor).toBe(ReceptorType.SEDE_EDUCATIVA);
    expect(schoolRes.notificaciones_acudientes_encoladas).toBe(2);

    // 2. Recorrido TARDE -> ACUDIENTE y ADULTO_AUTORIZADO vigente
    const afternoonTrip = makeUuid(103);
    const studentGuardian = makeUuid(1003);
    const studentAuthorized = makeUuid(1004);
    await seedBoardedTrip({
      tripId: afternoonTrip,
      jornada: "TARDE",
      studentIds: [studentGuardian, studentAuthorized],
    });

    repository.registerAuthorizedAdultLink({
      id_autorizado: authValidId,
      id_estudiante: studentAuthorized,
      nombres: "Elena",
      apellidos: "Abuela",
      documento_blind_index:
        deliveryValidationService.computeDocumentBlindIndex("42012345"),
      parentesco: "ABUELA",
      prioridad_retiro: 1,
      adulto_activo: true,
      autorizacion_activa: true,
      autorizado_hasta: new Date(Date.now() + 86_400_000),
      expediente_revocado: false,
    });

    const guardianRes = await useCase.executeDisembark({
      id_viaje: afternoonTrip,
      id_estudiante: studentGuardian,
      tipo_receptor: ReceptorType.ACUDIENTE,
      documento_receptor: "1.088.100.200",
      coordenadas_gps: PEREIRA_HOME_COORDS,
      registrado_por_usuario: monitoraUserId,
    });
    expect(guardianRes.aprobado).toBe(true);
    expect(guardianRes.id_acudiente_receptor).toBe(guardian1Id);
    expect(guardianRes.estado_custodia).toBe(
      FsmCustodyState.ENTREGADO_ACUDIENTE,
    );
    expect(guardianRes.total_a_bordo).toBe(1);

    const authRes = await useCase.executeDisembark({
      id_viaje: afternoonTrip,
      id_estudiante: studentAuthorized,
      tipo_receptor: ReceptorType.ADULTO_AUTORIZADO,
      documento_receptor: "42012345",
      coordenadas_gps: PEREIRA_HOME_COORDS,
      registrado_por_usuario: monitoraUserId,
    });
    expect(authRes.aprobado).toBe(true);
    expect(authRes.id_autorizado_receptor).toBe(authValidId);
    expect(authRes.estado_custodia).toBe(FsmCustodyState.ENTREGADO_ACUDIENTE);
    expect(authRes.total_a_bordo).toBe(0);
    expect(realtimePort.disembarkedEvents).toHaveLength(3);
  });

  it("Mitigación de riesgo de hermanos: validación independiente por menor y una fila separada de entrega por cada estudiante", async () => {
    const tripId = makeUuid(104);
    const siblingA = makeUuid(1010);
    const siblingB = makeUuid(1011);
    await seedBoardedTrip({
      tripId,
      jornada: "TARDE",
      studentIds: [siblingA, siblingB],
    });

    // Adulto autorizado ÚNICAMENTE para siblingA
    repository.registerAuthorizedAdultLink({
      id_autorizado: authValidId,
      id_estudiante: siblingA,
      nombres: "Elena",
      apellidos: "Tía",
      documento_blind_index:
        deliveryValidationService.computeDocumentBlindIndex("52000111"),
      parentesco: "TIA",
      prioridad_retiro: 1,
      adulto_activo: true,
      autorizacion_activa: true,
      autorizado_hasta: new Date(Date.now() + 86_400_000),
      expediente_revocado: false,
    });

    const deliveryA = await useCase.executeDisembark({
      id_viaje: tripId,
      id_estudiante: siblingA,
      tipo_receptor: ReceptorType.ADULTO_AUTORIZADO,
      documento_receptor: "52000111",
      coordenadas_gps: PEREIRA_HOME_COORDS,
      registrado_por_usuario: monitoraUserId,
    });
    expect(deliveryA.aprobado).toBe(true);
    expect(deliveryA.total_a_bordo).toBe(1);

    // Intento de retirar al hermano B con el mismo adulto NO autorizado para B -> 403 Forbidden
    await expect(
      useCase.executeDisembark({
        id_viaje: tripId,
        id_estudiante: siblingB,
        tipo_receptor: ReceptorType.ADULTO_AUTORIZADO,
        documento_receptor: "52000111",
        coordenadas_gps: PEREIRA_HOME_COORDS,
        registrado_por_usuario: monitoraUserId,
      }),
    ).rejects.toThrow(ForbiddenException);

    // siblingB sigue a bordo sin entrega ni decremento
    expect((await repository.getTripOccupancy(tripId))?.total_a_bordo).toBe(1);

    // Acudiente titular retira a siblingB -> crea una segunda fila independiente en `entrega`
    const deliveryB = await useCase.executeDisembark({
      id_viaje: tripId,
      id_estudiante: siblingB,
      tipo_receptor: ReceptorType.ACUDIENTE,
      documento_receptor: "1088100200",
      coordenadas_gps: PEREIRA_HOME_COORDS,
      registrado_por_usuario: monitoraUserId,
    });
    expect(deliveryB.aprobado).toBe(true);
    expect(deliveryB.id_entrega).not.toBe(deliveryA.id_entrega);
    expect(deliveryB.total_a_bordo).toBe(0);

    const allDeliveries = await repository.listStudentDeliveries(tripId);
    expect(allDeliveries).toHaveLength(2);
    expect(new Set(allDeliveries.map((d) => d.id_estudiante))).toEqual(
      new Set([siblingA, siblingB]),
    );
  });

  it("rechaza con 403 y registra incidente en entregas con autorizado vencido, revocado, inexistente o alerta judicial sin alterar aforo ni custodia", async () => {
    const tripId = makeUuid(105);
    const studentId = makeUuid(1020);
    await seedBoardedTrip({
      tripId,
      jornada: "TARDE",
      studentIds: [studentId],
    });

    repository.registerAuthorizedAdultLink({
      id_autorizado: authExpiredId,
      id_estudiante: studentId,
      nombres: "Tío",
      apellidos: "Vencido",
      documento_blind_index:
        deliveryValidationService.computeDocumentBlindIndex("31000111"),
      parentesco: "TIO",
      prioridad_retiro: 1,
      adulto_activo: true,
      autorizacion_activa: true,
      autorizado_hasta: new Date(Date.now() - 60_000),
      expediente_revocado: false,
    });

    repository.registerAuthorizedAdultLink({
      id_autorizado: authRevokedId,
      id_estudiante: studentId,
      nombres: "Tío",
      apellidos: "Revocado",
      documento_blind_index:
        deliveryValidationService.computeDocumentBlindIndex("31000222"),
      parentesco: "TIO",
      prioridad_retiro: 2,
      adulto_activo: true,
      autorizacion_activa: true,
      autorizado_hasta: null,
      expediente_revocado: true,
    });

    repository.registerJudicialAlert({
      id_alerta: makeUuid(888),
      id_estudiante: studentId,
      radicado_medida: "RAD-JUD-2026-99",
      individuo_blind_index:
        deliveryValidationService.computeDocumentBlindIndex("666000666"),
      activa: true,
      eliminado_soft: false,
    });

    // 1. Vencido
    await expect(
      useCase.executeDisembark({
        id_viaje: tripId,
        id_estudiante: studentId,
        tipo_receptor: ReceptorType.ADULTO_AUTORIZADO,
        documento_receptor: "31000111",
        coordenadas_gps: PEREIRA_HOME_COORDS,
        registrado_por_usuario: monitoraUserId,
      }),
    ).rejects.toThrow(ForbiddenException);

    // 2. Revocado
    await expect(
      useCase.executeDisembark({
        id_viaje: tripId,
        id_estudiante: studentId,
        tipo_receptor: ReceptorType.ADULTO_AUTORIZADO,
        documento_receptor: "31000222",
        coordenadas_gps: PEREIRA_HOME_COORDS,
        registrado_por_usuario: monitoraUserId,
      }),
    ).rejects.toThrow(ForbiddenException);

    // 3. Inexistente
    await expect(
      useCase.executeDisembark({
        id_viaje: tripId,
        id_estudiante: studentId,
        tipo_receptor: ReceptorType.ADULTO_AUTORIZADO,
        documento_receptor: "999888777",
        coordenadas_gps: PEREIRA_HOME_COORDS,
        registrado_por_usuario: monitoraUserId,
      }),
    ).rejects.toThrow(ForbiddenException);

    // 4. Alerta judicial activa
    await expect(
      useCase.executeDisembark({
        id_viaje: tripId,
        id_estudiante: studentId,
        tipo_receptor: ReceptorType.ADULTO_AUTORIZADO,
        documento_receptor: "666000666",
        coordenadas_gps: PEREIRA_HOME_COORDS,
        registrado_por_usuario: monitoraUserId,
      }),
    ).rejects.toThrow(ForbiddenException);

    // Invariante fail-safe: el menor sigue A_BORDO_VEHICULO y total_a_bordo sigue en 1
    expect((await repository.getTripOccupancy(tripId))?.total_a_bordo).toBe(1);
    const custody = await custodyService.getStudentTripCustody(
      tripId,
      studentId,
    );
    expect(custody.estado_custodia).toBe(FsmCustodyState.A_BORDO_VEHICULO);

    const incidents = await repository.listTripIncidents(tripId);
    expect(incidents).toHaveLength(4);
    expect(
      incidents.some(
        (i) =>
          i.tipo_incidente === "ALERTA_JUDICIAL_DETECTADA" &&
          i.severidad === "CRITICO",
      ),
    ).toBe(true);
    expect(realtimePort.unauthorizedReceptorAlerts).toHaveLength(4);
  });

  it("protege idempotencia, valida casos borde (viaje inexistente 404, no EN_CURSO 409, no a bordo 422, coordenadas 400, sin tipo_receptor 400, concurrencia)", async () => {
    const tripId = makeUuid(106);
    const s1 = makeUuid(1030);
    const s2 = makeUuid(1031);
    await seedBoardedTrip({
      tripId,
      jornada: "TARDE",
      studentIds: [s1, s2],
    });

    // Idempotencia: reintento con misma clave no decrementa dos veces
    const first = await useCase.executeDisembark({
      id_viaje: tripId,
      id_estudiante: s1,
      tipo_receptor: ReceptorType.ACUDIENTE,
      documento_receptor: "1088100200",
      coordenadas_gps: PEREIRA_HOME_COORDS,
      idempotency_key: "idem-descenso-1",
    });
    expect(first.total_a_bordo).toBe(1);
    expect(first.duplicado_por_idempotencia).toBe(false);

    const retry = await useCase.executeDisembark({
      id_viaje: tripId,
      id_estudiante: s1,
      tipo_receptor: ReceptorType.ACUDIENTE,
      documento_receptor: "1088100200",
      coordenadas_gps: PEREIRA_HOME_COORDS,
      idempotency_key: "idem-descenso-1",
    });
    expect(retry.duplicado_por_idempotencia).toBe(true);
    expect(retry.id_entrega).toBe(first.id_entrega);
    expect(retry.total_a_bordo).toBe(1);

    // Estudiante ya entregado (no A_BORDO_VEHICULO) con otra clave -> 422
    await expect(
      useCase.executeDisembark({
        id_viaje: tripId,
        id_estudiante: s1,
        tipo_receptor: ReceptorType.ACUDIENTE,
        documento_receptor: "1088100200",
        coordenadas_gps: PEREIRA_HOME_COORDS,
        idempotency_key: "idem-descenso-2",
      }),
    ).rejects.toThrow(UnprocessableEntityException);

    // Finalizar sede cuando el estudiante NO está en RETORNO_SEDE_POR_FALLA_ENTREGA -> 422
    await expect(
      useCase.finalizeSchoolCustody({
        id_viaje: tripId,
        id_estudiante: s2,
        recibido_por_coordinador: coordinatorId,
        coordenadas_gps: SAN_BENITO_SCHOOL_COORDS,
      }),
    ).rejects.toThrow(UnprocessableEntityException);

    // Viaje inexistente -> 404
    await expect(
      useCase.executeDisembark({
        id_viaje: makeUuid(9999),
        id_estudiante: s2,
        tipo_receptor: ReceptorType.ACUDIENTE,
        documento_receptor: "1088100200",
        coordenadas_gps: PEREIRA_HOME_COORDS,
      }),
    ).rejects.toThrow(NotFoundException);

    // Coordenadas inválidas -> 400
    await expect(
      useCase.executeDisembark({
        id_viaje: tripId,
        id_estudiante: s2,
        tipo_receptor: ReceptorType.ACUDIENTE,
        documento_receptor: "1088100200",
        coordenadas_gps: { latitud: 120, longitud: -75.69 },
      }),
    ).rejects.toThrow(BadRequestException);

    // Entrega exitosa sin tipo_receptor -> 400
    await expect(
      useCase.executeDisembark({
        id_viaje: tripId,
        id_estudiante: s2,
        resultado_entrega: DisembarkOutcomeType.ENTREGADO_EXITOSO,
        coordenadas_gps: PEREIRA_HOME_COORDS,
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
