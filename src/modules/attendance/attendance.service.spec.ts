import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { HashService } from "@common/crypto/hash.service";
import { CustodyStateEnum } from "@common/enums/custody-state.enum";
import { TripStateEnum } from "@common/enums/trip-state.enum";
import { AuditService } from "../audit/audit.service";
import { CustodyService } from "../custody/custody.service";
import { FsmCustodyState } from "../custody/domain/custody.types";
import { InMemoryCustodyRepository } from "../custody/infrastructure/in-memory-custody.repository";
import { NotificationsService } from "../notifications/notifications.service";
import { AttendanceService } from "./attendance.service";
import { BoardingNotificationQueueService } from "./boarding-notification-queue.service";
import { CapacityEnforcer } from "./capacity-enforcer.service";
import { IAttendanceRealtimePort } from "./domain/attendance-realtime.port";
import {
  BoardingResultCode,
  InvalidQrTokenError,
  OvercapacityAlertEventPayload,
  StudentBoardedEventPayload,
} from "./domain/attendance.types";
import { IncidentLogger } from "./incident-logger.service";
import { InMemoryAttendanceRepository } from "./infrastructure/in-memory-attendance.repository";
import { QrTokenValidator } from "./qr-token-validator.service";

const makeUuid = (suffix: number) =>
  `018e38d9-3f00-7200-a000-${String(suffix).padStart(12, "0")}`;

const PEREIRA_COORDS = { latitud: 4.8133, longitud: -75.6961 };

class RecordingRealtimePort implements IAttendanceRealtimePort {
  readonly boardedEvents: StudentBoardedEventPayload[] = [];
  readonly overcapacityAlerts: OvercapacityAlertEventPayload[] = [];

  async emitStudentBoarded(
    payload: StudentBoardedEventPayload,
  ): Promise<void> {
    this.boardedEvents.push(payload);
  }

  async emitOvercapacityAlert(
    payload: OvercapacityAlertEventPayload,
  ): Promise<void> {
    this.overcapacityAlerts.push(payload);
  }
}

describe("Attendance Module (Issue #8: Abordaje QR atómico, RN-02, RN-05 y concurrencia)", () => {
  const hashService = new HashService();
  const routeId = makeUuid(100);
  const monitoraUserId = makeUuid(900);

  describe("CapacityEnforcer (SRP - RN-02)", () => {
    const enforcer = new CapacityEnforcer();

    it("autoriza abordaje cuando total_a_bordo < capacidad_nominal y calcula ocupación", () => {
      expect(enforcer.canBoard(0, 15)).toBe(true);
      const evaluation = enforcer.evaluateBoardingCapacity(14, 15);
      expect(evaluation.permitido).toBe(true);
      expect(evaluation.codigo).toBe(BoardingResultCode.ABORDAJE_EXITOSO);
      expect(evaluation.total_proyectado).toBe(15);
      expect(evaluation.cupos_restantes).toBe(0);
      expect(evaluation.porcentaje_ocupacion).toBe(100);
    });

    it("deniega con DENEGADO_SOBRECUPO al alcanzar la capacidad homologada (15/15)", () => {
      expect(enforcer.canBoard(15, 15)).toBe(false);
      const evaluation = enforcer.evaluateBoardingCapacity(15, 15);
      expect(evaluation.permitido).toBe(false);
      expect(evaluation.codigo).toBe(BoardingResultCode.DENEGADO_SOBRECUPO);
      expect(evaluation.total_proyectado).toBe(15);
      expect(evaluation.cupos_restantes).toBe(0);
    });

    it("rechaza límites de capacidad inválidos", () => {
      expect(() => enforcer.assertValidCapacityBounds(0, 0)).toThrow(
        RangeError,
      );
      expect(() => enforcer.assertValidCapacityBounds(-1, 10)).toThrow(
        RangeError,
      );
    });
  });

  describe("QrTokenValidator (SRP - QR estático y dinámico HMAC-SHA256)", () => {
    const validator = new QrTokenValidator(hashService);

    it("genera y valida un QR dinámico firmado dentro de su ventana TTL", () => {
      const studentId = makeUuid(1);
      const token = validator.generateDynamicQrToken(studentId, 300, 1_700_000_000);
      const validated = validator.validate(
        token,
        "QR_INSTITUCIONAL",
        1_700_000_100,
      );

      expect(validated.tipo).toBe("DINAMICO");
      expect(validated.id_estudiante).toBe(studentId);
      expect(validated.qr_token_hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("rechaza QR dinámico expirado (QR_EXPIRADO) o con firma manipulada (QR_INVALIDO)", () => {
      const studentId = makeUuid(2);
      const token = validator.generateDynamicQrToken(studentId, 60, 1_700_000_000);

      expect(() =>
        validator.validate(token, "QR_INSTITUCIONAL", 1_700_000_061),
      ).toThrow(InvalidQrTokenError);

      try {
        validator.validate(token, "QR_INSTITUCIONAL", 1_700_000_061);
      } catch (err) {
        expect((err as InvalidQrTokenError).code).toBe("QR_EXPIRADO");
      }

      const tampered = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
      expect(() =>
        validator.validate(tampered, "QR_INSTITUCIONAL", 1_700_000_010),
      ).toThrow(InvalidQrTokenError);
    });

    it("calcula hash SHA-256 para tokens QR estáticos institucionales y rechaza vacíos", () => {
      const validated = validator.validate("QR-EST-SAN-BENITO-001");
      expect(validated.tipo).toBe("ESTATICO");
      expect(validated.id_estudiante).toBeNull();
      expect(validated.qr_token_hash).toBe(
        hashService.sha256("QR-EST-SAN-BENITO-001"),
      );

      expect(() => validator.validate("   ")).toThrow(InvalidQrTokenError);
    });
  });

  describe("AttendanceService + IncidentLogger + Concurrencia Real", () => {
    let repository: InMemoryAttendanceRepository;
    let custodyRepository: InMemoryCustodyRepository;
    let custodyService: CustodyService;
    let realtimePort: RecordingRealtimePort;
    let notificationsService: NotificationsService;
    let notificationQueue: BoardingNotificationQueueService;
    let auditService: AuditService;
    let incidentLogger: IncidentLogger;
    let qrValidator: QrTokenValidator;
    let capacityEnforcer: CapacityEnforcer;
    let service: AttendanceService;

    beforeEach(() => {
      capacityEnforcer = new CapacityEnforcer();
      custodyRepository = new InMemoryCustodyRepository();
      custodyService = new CustodyService(custodyRepository);
      repository = new InMemoryAttendanceRepository(
        capacityEnforcer,
        custodyService,
      );
      realtimePort = new RecordingRealtimePort();
      notificationsService = new NotificationsService();
      notificationQueue = new BoardingNotificationQueueService(
        notificationsService,
      );
      auditService = new AuditService();
      incidentLogger = new IncidentLogger(
        repository,
        realtimePort,
        auditService,
      );
      qrValidator = new QrTokenValidator(hashService);
      service = new AttendanceService(
        repository,
        qrValidator,
        capacityEnforcer,
        incidentLogger,
        realtimePort,
        notificationQueue,
      );
    });

    function seedTripWithStudents(
      tripId: string,
      capacity: number,
      studentCount: number,
      initialOnBoard = 0,
      estado: TripStateEnum = TripStateEnum.EN_CURSO,
    ) {
      repository.registerTrip({
        id_viaje: tripId,
        id_ruta: routeId,
        estado,
        jornada: "MANANA",
        capacidad_nominal: capacity,
        total_a_bordo: initialOnBoard,
      });

      const students: Array<{
        id: string;
        qrRaw: string;
        guardianId: string;
      }> = [];

      for (let i = 1; i <= studentCount; i++) {
        const id = makeUuid(1000 + i);
        const guardianId = makeUuid(5000 + i);
        const qrRaw = `QR-EST-${tripId.slice(-4)}-${i}`;

        repository.registerStudent({
          id_estudiante: id,
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
        students.push({ id, qrRaw, guardianId });
      }

      return students;
    }

    it("Criterio de Aceptación #8: vehículo capacidad 15 con 15 a bordo rechaza al #16 con DENEGADO_SOBRECUPO, sin incrementar contador, registrando incidente y alertando a Coordinación", async () => {
      const tripId = makeUuid(201);
      const students = seedTripWithStudents(tripId, 15, 16, 0);

      for (let i = 0; i < 15; i++) {
        const ok = await service.registerBoarding({
          id_viaje: tripId,
          qr_token: students[i].qrRaw,
          coordenadas_gps: PEREIRA_COORDS,
          registrado_por_usuario: monitoraUserId,
        });
        expect(ok.aprobado).toBe(true);
        expect(ok.codigo).toBe(BoardingResultCode.ABORDAJE_EXITOSO);
        expect(ok.total_a_bordo).toBe(i + 1);
      }

      const rejected16 = await service.registerBoarding({
        id_viaje: tripId,
        qr_token: students[15].qrRaw,
        coordenadas_gps: PEREIRA_COORDS,
        registrado_por_usuario: monitoraUserId,
      });

      expect(rejected16.aprobado).toBe(false);
      expect(rejected16.codigo).toBe(BoardingResultCode.DENEGADO_SOBRECUPO);
      expect(rejected16.total_a_bordo).toBe(15);
      expect(rejected16.capacidad_nominal).toBe(15);
      expect(rejected16.id_asistencia).toBeNull();
      expect(rejected16.id_incidente).toBeTruthy();
      expect(rejected16.alerta_coordinacion_emitida).toBe(true);
      expect(rejected16.evento_realtime_emitido).toBeNull();
      expect(rejected16.notificacion_acudiente_encolada).toBe(false);

      const occupancy = await repository.getTripOccupancy(tripId);
      expect(occupancy?.total_a_bordo).toBe(15);

      const incidents = await repository.listTripIncidents(tripId);
      expect(incidents).toHaveLength(1);
      expect(incidents[0].tipo_incidente).toBe("INTENTO_SOBRECUPO");
      expect(incidents[0].severidad).toBe("CRITICO");
      expect(incidents[0].id_estudiante).toBe(students[15].id);

      expect(realtimePort.boardedEvents).toHaveLength(15);
      expect(realtimePort.overcapacityAlerts).toHaveLength(1);
      expect(realtimePort.overcapacityAlerts[0].codigo).toBe(
        BoardingResultCode.DENEGADO_SOBRECUPO,
      );
      expect(realtimePort.overcapacityAlerts[0].id_incidente).toBe(
        rejected16.id_incidente,
      );

      await notificationQueue.flushPendingDispatches();
      expect(notificationQueue.listQueuedNotifications()).toHaveLength(15);
    });

    it("Prueba de estrés concurrente (DoD Issue #8): 20 abordajes simultáneos sobre vehículo de capacidad 5 -> exactamente 5 aprobados y 15 DENEGADO_SOBRECUPO", async () => {
      const tripId = makeUuid(202);
      const students = seedTripWithStudents(tripId, 5, 20, 0);
      // Simular latencia asíncrona real de I/O dentro de la sección crítica para forzar interleaving
      repository.setSimulatedIoDelayMs(3);

      const results = await Promise.all(
        students.map((student, idx) =>
          service.registerBoarding({
            id_viaje: tripId,
            qr_token: student.qrRaw,
            coordenadas_gps: PEREIRA_COORDS,
            idempotency_key: `stress-20-${idx + 1}`,
            registrado_por_usuario: monitoraUserId,
          }),
        ),
      );

      const approved = results.filter((r) => r.aprobado);
      const denied = results.filter(
        (r) => !r.aprobado && r.codigo === BoardingResultCode.DENEGADO_SOBRECUPO,
      );

      expect(approved).toHaveLength(5);
      expect(denied).toHaveLength(15);

      // Todos los contadores aprobados deben formar exactamente la secuencia {1, 2, 3, 4, 5}
      expect(approved.map((r) => r.total_a_bordo).sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5,
      ]);
      // Ningún rechazo puede reportar aforo > 5
      expect(denied.every((r) => r.total_a_bordo === 5)).toBe(true);

      const occupancy = await repository.getTripOccupancy(tripId);
      expect(occupancy?.total_a_bordo).toBe(5);

      const incidents = await repository.listTripIncidents(tripId);
      expect(incidents).toHaveLength(15);
      expect(incidents.every((i) => i.tipo_incidente === "INTENTO_SOBRECUPO")).toBe(
        true,
      );

      expect(realtimePort.boardedEvents).toHaveLength(5);
      expect(realtimePort.overcapacityAlerts).toHaveLength(15);

      // Integridad criptográfica WORM de custodia (Issue #7) tras los 5 abordajes
      const integrity = await custodyService.verifyWormChainIntegrity();
      expect(integrity.cadena_integra).toBe(true);
      expect(integrity.total_verificados).toBe(10); // 5 x (NO_INICIADO->EN_ESPERA + EN_ESPERA->A_BORDO)

      await notificationQueue.flushPendingDispatches();
      expect(notificationQueue.listQueuedNotifications()).toHaveLength(5);
    });

    it("RN-05 y clave idempotente: 10 escaneos simultáneos del mismo estudiante aprueban exactamente 1 y rechazan 9 con ABORDAJE_PREVIO_EXISTE", async () => {
      const tripId = makeUuid(203);
      const [student] = seedTripWithStudents(tripId, 15, 1, 0);
      repository.setSimulatedIoDelayMs(2);

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, idx) =>
          service.registerBoarding({
            id_viaje: tripId,
            qr_token: student.qrRaw,
            coordenadas_gps: PEREIRA_COORDS,
            idempotency_key: idx < 5 ? "idem-key-repetida" : `idem-key-${idx}`,
            registrado_por_usuario: monitoraUserId,
          }),
        ),
      );

      const approved = results.filter((r) => r.aprobado);
      const duplicates = results.filter(
        (r) => r.codigo === BoardingResultCode.ABORDAJE_PREVIO_EXISTE,
      );

      expect(approved).toHaveLength(1);
      expect(duplicates).toHaveLength(9);
      expect(duplicates.some((d) => d.duplicado_por_idempotencia)).toBe(true);

      const occupancy = await repository.getTripOccupancy(tripId);
      expect(occupancy?.total_a_bordo).toBe(1);

      const incidents = await repository.listTripIncidents(tripId);
      expect(incidents).toHaveLength(9);
      expect(
        incidents.every((i) => i.tipo_incidente === "DOBLE_ABORDAJE_DETECTADO"),
      ).toBe(true);
      expect(realtimePort.boardedEvents).toHaveLength(1);
    });

    it("soporta QR dinámico HMAC-SHA256 y pase ocasional aprobado (QR_OCASIONAL_TEMPORAL)", async () => {
      const tripId = makeUuid(204);
      const [regularStudent] = seedTripWithStudents(tripId, 5, 1, 0);

      // 1. Abordaje con QR dinámico firmado
      const dynamicToken = qrValidator.generateDynamicQrToken(regularStudent.id);
      const dynamicRes = await service.registerBoarding({
        id_viaje: tripId,
        qr_token: dynamicToken,
        coordenadas_gps: PEREIRA_COORDS,
        registrado_por_usuario: monitoraUserId,
      });
      expect(dynamicRes.aprobado).toBe(true);
      expect(dynamicRes.estado_custodia).toBe(FsmCustodyState.A_BORDO_VEHICULO);
      expect(dynamicRes.evento_realtime_emitido).toBe("student:boarded");
      expect(dynamicRes.notificacion_acudiente_encolada).toBe(true);
      expect(dynamicRes.latencia_ms).toBeLessThan(200);

      // 2. Abordaje con QR de pasajero ocasional aprobado (sin asignación regular a la ruta)
      const occasionalId = makeUuid(3001);
      const occasionalQrRaw = "QR-OCASIONAL-TEMP-999";
      repository.registerStudent({
        id_estudiante: occasionalId,
        activo: true,
        qr_token_hash: hashService.sha256("QR-PROPIO-OTRA-RUTA"),
        id_acudiente_titular: makeUuid(7001),
      });
      repository.registerOccasionalPass({
        id_pasajero_ocasional: makeUuid(4001),
        id_viaje: tripId,
        id_estudiante: occasionalId,
        qr_provisional_hash: hashService.sha256(occasionalQrRaw),
        estado_solicitud: "APROBADO_COORDINACION",
      });

      const occasionalRes = await service.registerBoarding({
        id_viaje: tripId,
        qr_token: occasionalQrRaw,
        coordenadas_gps: PEREIRA_COORDS,
        registrado_por_usuario: monitoraUserId,
      });
      expect(occasionalRes.aprobado).toBe(true);
      expect(occasionalRes.metodo_validacion).toBe("QR_OCASIONAL_TEMPORAL");
      expect(occasionalRes.total_a_bordo).toBe(2);
    });

    it("rechaza viaje inexistente (404), viaje no EN_CURSO (409), QR inválido/expirado (422), estudiante no asignado (422) y coordenadas inválidas (400)", async () => {
      const tripProgramado = makeUuid(205);
      const [studentProg] = seedTripWithStudents(
        tripProgramado,
        10,
        1,
        0,
        TripStateEnum.PROGRAMADO,
      );

      await expect(
        service.registerBoarding({
          id_viaje: makeUuid(9999),
          qr_token: studentProg.qrRaw,
          coordenadas_gps: PEREIRA_COORDS,
        }),
      ).rejects.toThrow(NotFoundException);

      await expect(
        service.registerBoarding({
          id_viaje: tripProgramado,
          qr_token: studentProg.qrRaw,
          coordenadas_gps: PEREIRA_COORDS,
        }),
      ).rejects.toThrow(ConflictException);

      const tripActivo = makeUuid(206);
      seedTripWithStudents(tripActivo, 10, 1, 0, TripStateEnum.EN_CURSO);

      // QR no registrado
      await expect(
        service.registerBoarding({
          id_viaje: tripActivo,
          qr_token: "QR-DESCONOCIDO-XYZ",
          coordenadas_gps: PEREIRA_COORDS,
        }),
      ).rejects.toThrow(UnprocessableEntityException);

      // Estudiante activo pero sin asignación a la ruta del viaje
      const unassignedId = makeUuid(3002);
      const unassignedQr = "QR-SIN-RUTA-3002";
      repository.registerStudent({
        id_estudiante: unassignedId,
        activo: true,
        qr_token_hash: hashService.sha256(unassignedQr),
      });

      await expect(
        service.registerBoarding({
          id_viaje: tripActivo,
          qr_token: unassignedQr,
          coordenadas_gps: PEREIRA_COORDS,
        }),
      ).rejects.toThrow(UnprocessableEntityException);

      // Coordenadas fuera de rango WGS84
      await expect(
        service.registerBoarding({
          id_viaje: tripActivo,
          qr_token: unassignedQr,
          coordenadas_gps: { latitud: 95, longitud: -75.6961 },
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("mantiene compatibilidad del placeholder registerAlighting (fuera de alcance #9)", async () => {
      const result = await service.registerAlighting("trip-1", "est-1");
      expect(result.estado_custodia).toBe(CustodyStateEnum.ENTREGADO_A_TUTOR);
    });
  });
});
