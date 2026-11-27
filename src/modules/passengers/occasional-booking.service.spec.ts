import {
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { HashService } from "@common/crypto/hash.service";
import { TripStateEnum } from "@common/enums/trip-state.enum";
import { AttendanceService } from "../attendance/attendance.service";
import { CapacityEnforcer } from "../attendance/capacity-enforcer.service";
import { BoardingResultCode } from "../attendance/domain/attendance.types";
import { InMemoryAttendanceRepository } from "../attendance/infrastructure/in-memory-attendance.repository";
import { AuditService } from "../audit/audit.service";
import { CustodyService } from "../custody/custody.service";
import { FsmCustodyState, TripDirection } from "../custody/domain/custody.types";
import { InMemoryCustodyRepository } from "../custody/infrastructure/in-memory-custody.repository";
import {
  OccasionalRejectionReason,
  OccasionalRequestStatus,
} from "./domain/occasional-passenger.types";
import { InMemoryOccasionalPassengerRepository } from "./infrastructure/in-memory-occasional-passenger.repository";
import { OccasionalBookingService } from "./occasional-booking.service";
import { PassengerCapacityEvaluator } from "./passenger-capacity-evaluator.service";

const makeUuid = (suffix: number) =>
  `018e38d9-3f00-7200-a600-${String(suffix).padStart(12, "0")}`;

describe("OccasionalBookingService (Issue #11 — Transaccional, Concurrencia y Rollback)", () => {
  const schoolId = makeUuid(1);
  const otherSchoolId = makeUuid(2);
  const routeId = makeUuid(10);
  const tripId = makeUuid(20);
  const coordinatorUserId = makeUuid(30);
  const coordinatorId = makeUuid(31);
  const otherCoordUserId = makeUuid(32);
  const otherCoordId = makeUuid(33);
  const guardianUserId = makeUuid(40);
  const guardianId = makeUuid(41);
  const intruderGuardianUserId = makeUuid(42);
  const intruderGuardianId = makeUuid(43);
  const regularStudentId = makeUuid(100);
  const occasionalStudentId = makeUuid(200);

  const departure0630 = new Date("2026-11-30T06:30:00.000-05:00");
  let currentTime: Date;

  let evaluator: PassengerCapacityEvaluator;
  let custodyRepo: InMemoryCustodyRepository;
  let custodyService: CustodyService;
  let attendanceRepo: InMemoryAttendanceRepository;
  let attendanceService: AttendanceService;
  let repository: InMemoryOccasionalPassengerRepository;
  let service: OccasionalBookingService;
  let hashService: HashService;

  beforeEach(() => {
    currentTime = new Date("2026-11-30T04:00:00.000-05:00"); // 2.5h antes de 06:30 AM
    evaluator = new PassengerCapacityEvaluator();
    hashService = new HashService();
    custodyRepo = new InMemoryCustodyRepository();
    custodyService = new CustodyService(custodyRepo);
    attendanceRepo = new InMemoryAttendanceRepository(
      new CapacityEnforcer(),
      custodyService,
    );
    attendanceService = new AttendanceService(attendanceRepo);
    repository = new InMemoryOccasionalPassengerRepository(
      evaluator,
      custodyService,
      attendanceRepo,
    );
    service = new OccasionalBookingService(
      repository,
      evaluator,
      hashService,
      new AuditService(),
      () => currentTime,
    );

    repository.registerTrip({
      id_viaje: tripId,
      id_ruta: routeId,
      id_colegio: schoolId,
      jornada: "MANANA",
      estado: TripStateEnum.PROGRAMADO,
      hora_inicio_programada: departure0630,
      capacidad_nominal: 2,
    });

    // Dos estudiantes regulares llenando capacidad nominal 2/2
    const regularStudent2 = makeUuid(101);
    for (const id of [regularStudentId, regularStudent2]) {
      repository.registerStudent({
        id_estudiante: id,
        id_colegio: schoolId,
        activo: true,
      });
      repository.registerRouteAssignment({
        id_estudiante: id,
        id_ruta: routeId,
        ciclo_horario: "AMBOS",
        activa: true,
      });
    }

    repository.registerStudent({
      id_estudiante: occasionalStudentId,
      id_colegio: schoolId,
      activo: true,
    });
    repository.registerGuardianLink({
      id_acudiente: guardianId,
      id_usuario: guardianUserId,
      id_estudiante: occasionalStudentId,
    });
    repository.registerGuardianLink({
      id_acudiente: intruderGuardianId,
      id_usuario: intruderGuardianUserId,
      id_estudiante: regularStudentId,
    });

    repository.registerCoordinator({
      id_coordinador: coordinatorId,
      id_usuario: coordinatorUserId,
      id_colegio: schoolId,
    });
    repository.registerCoordinator({
      id_coordinador: otherCoordId,
      id_usuario: otherCoordUserId,
      id_colegio: otherSchoolId,
    });
  });

  it("Criterio de Aceptación: viaje 06:30 AM sin inasistencias + solicitud 05:00 AM rechaza por AMBOS motivos (vacante y antelación < 2h)", async () => {
    currentTime = new Date("2026-11-30T05:00:00.000-05:00");

    try {
      await service.requestOccasionalSeat({
        id_viaje: tripId,
        id_estudiante: occasionalStudentId,
        solicitado_por_usuario: guardianUserId,
        motivo: "Taller académico",
      });
      fail("Debió lanzar UnprocessableEntityException");
    } catch (error) {
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      const response = (error as UnprocessableEntityException).getResponse() as {
        code: string;
        motivos_rechazo: OccasionalRejectionReason[];
        detalle_antelacion: { cumple_antelacion: boolean; horas_antelacion: number };
      };
      expect(response.code).toBe("REGLAS_PASAJERO_OCASIONAL_INCUMPLIDAS");
      expect(response.motivos_rechazo).toContain(
        OccasionalRejectionReason.ANTELACION_INSUFICIENTE,
      );
      expect(response.motivos_rechazo).toContain(
        OccasionalRejectionReason.SIN_VACANTE_POR_INASISTENCIA,
      );
      expect(response.detalle_antelacion.cumple_antelacion).toBe(false);
      expect(response.detalle_antelacion.horas_antelacion).toBe(1.5);
    }
  });

  it("OWASP ASVS V4.1: rechaza con 403 si un acudiente intenta solicitar viaje para un estudiante que no es su hijo", async () => {
    repository.registerAbsence({
      id_viaje: tripId,
      id_estudiante: regularStudentId,
      reportado_por_acudiente: intruderGuardianId,
      cupo_liberado: true,
    });

    await expect(
      service.requestOccasionalSeat({
        id_viaje: tripId,
        id_estudiante: occasionalStudentId,
        solicitado_por_usuario: intruderGuardianUserId,
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it("flujo completo: solicitud (>=2h + inasistencia) -> aprobación Coordinación -> inclusión en viaje_estudiante -> abordaje QR ocasional (Issues #7 y #8)", async () => {
    repository.registerAbsence({
      id_viaje: tripId,
      id_estudiante: regularStudentId,
      reportado_por_acudiente: intruderGuardianId,
      cupo_liberado: true,
    });

    // Preparar el viaje y el estudiante en Custody y Attendance para probar integración con #7 y #8
    await custodyRepo.registerTrip({
      id_viaje: tripId,
      id_ruta: routeId,
      fecha: "2026-11-30",
      estado: TripStateEnum.EN_CURSO,
      tipo_recorrido: TripDirection.MANANA,
    });
    attendanceRepo.registerTrip({
      id_viaje: tripId,
      id_ruta: routeId,
      estado: TripStateEnum.EN_CURSO,
      jornada: "MANANA",
      capacidad_nominal: 2,
      total_a_bordo: 0,
    });
    attendanceRepo.registerStudent({
      id_estudiante: occasionalStudentId,
      id_colegio: schoolId,
      activo: true,
      qr_token_hash: hashService.sha256("regular-qr-est-ocasional"),
      id_acudiente_titular: guardianId,
    });

    const requested = await service.requestOccasionalSeat({
      id_viaje: tripId,
      id_estudiante: occasionalStudentId,
      solicitado_por_usuario: guardianUserId,
      motivo: "Cita familiar autorizada",
    });

    expect(requested.estado_solicitud).toBe(OccasionalRequestStatus.RADICADA);
    expect(requested.id_estudiante_que_libera_cupo).toBe(regularStudentId);
    expect(requested.balance_vacantes.vacantes_netas).toBe(0);
    expect(requested.qr_provisional_hash).toHaveLength(64);

    // Coordinación aprueba (incluso a las 05:30 AM, pues la radicación sí cumplió >= 2h)
    currentTime = new Date("2026-11-30T05:30:00.000-05:00");
    const approved = await service.approveOccasionalSeat({
      id_pasajero_ocasional: requested.id_pasajero_ocasional,
      aprobado_por_usuario: coordinatorUserId,
    });

    expect(approved.estado_solicitud).toBe(
      OccasionalRequestStatus.APROBADO_COORDINACION,
    );
    expect(approved.aprobado_por_coordinador).toBe(coordinatorId);
    expect(approved.lista_asistencia).toEqual({
      id_viaje: tripId,
      id_estudiante: occasionalStudentId,
      estado_custodia: FsmCustodyState.NO_INICIADO,
      es_pasajero_ocasional: true,
    });

    // Verificar sincronización automática con CustodyService (Issue #7)
    const custodyState = await custodyService.getStudentTripCustody(
      tripId,
      occasionalStudentId,
    );
    expect(custodyState?.es_pasajero_ocasional).toBe(true);
    expect(custodyState?.estado_custodia).toBe(FsmCustodyState.NO_INICIADO);

    // Verificar abordaje exitoso con QR provisional en AttendanceService (Issue #8)
    const boarding = await attendanceService.registerBoarding({
      id_viaje: tripId,
      qr_token: requested.qr_provisional_token,
      metodo_validacion: "QR_OCASIONAL_TEMPORAL",
      coordenadas_gps: { latitud: 4.8133, longitud: -75.6961 },
      registrado_por_usuario: makeUuid(999),
    });

    expect(boarding.aprobado).toBe(true);
    expect(boarding.codigo).toBe(BoardingResultCode.ABORDAJE_EXITOSO);
    expect(boarding.estado_custodia).toBe(FsmCustodyState.A_BORDO_VEHICULO);
    expect(boarding.total_a_bordo).toBe(1);
  });

  it("concurrencia sobre una única vacante: 10 solicitudes simultáneas -> exactamente 1 radicada y 9 rechazadas sin doble asignación", async () => {
    repository.setSimulatedIoDelayMs(10);
    repository.registerAbsence({
      id_viaje: tripId,
      id_estudiante: regularStudentId,
      reportado_por_acudiente: intruderGuardianId,
      cupo_liberado: true,
    });

    const competitors = Array.from({ length: 10 }, (_, idx) => {
      const studentId = makeUuid(300 + idx);
      const gUserId = makeUuid(400 + idx);
      const gId = makeUuid(500 + idx);
      repository.registerStudent({
        id_estudiante: studentId,
        id_colegio: schoolId,
        activo: true,
      });
      repository.registerGuardianLink({
        id_acudiente: gId,
        id_usuario: gUserId,
        id_estudiante: studentId,
      });
      return { studentId, gUserId };
    });

    const settled = await Promise.allSettled(
      competitors.map((c) =>
        service.requestOccasionalSeat({
          id_viaje: tripId,
          id_estudiante: c.studentId,
          solicitado_por_usuario: c.gUserId,
        }),
      ),
    );

    const successes = settled.filter((r) => r.status === "fulfilled");
    const rejections = settled.filter((r) => r.status === "rejected");

    expect(successes).toHaveLength(1);
    expect(rejections).toHaveLength(9);

    for (const rej of rejections) {
      if (rej.status === "rejected") {
        expect(rej.reason).toBeInstanceOf(UnprocessableEntityException);
      }
    }

    const finalBalance = await service.getTripVacancyBalance(tripId);
    expect(finalBalance.ocasionales_activos).toBe(1);
    expect(finalBalance.ocupacion_proyectada).toBe(2);
    expect(finalBalance.vacantes_netas).toBe(0);
  });

  it("rollback atómico ante fallo a mitad de aprobación: revierte estado a RADICADA y no deja registro parcial en viaje_estudiante", async () => {
    repository.registerAbsence({
      id_viaje: tripId,
      id_estudiante: regularStudentId,
      reportado_por_acudiente: intruderGuardianId,
      cupo_liberado: true,
    });

    const requested = await service.requestOccasionalSeat({
      id_viaje: tripId,
      id_estudiante: occasionalStudentId,
      solicitado_por_usuario: guardianUserId,
    });

    // Inyectar fallo a mitad de la transacción de aprobación (tras mutar pasajero_ocasional)
    repository.setNextApprovalManifestFailure(
      new Error("Fallo simulado escribiendo en viaje_estudiante"),
    );

    await expect(
      service.approveOccasionalSeat({
        id_pasajero_ocasional: requested.id_pasajero_ocasional,
        aprobado_por_usuario: coordinatorUserId,
      }),
    ).rejects.toThrow(InternalServerErrorException);

    // Verificar rollback completo: sigue RADICADA, sin aprobador ni entrada en viaje_estudiante
    const afterFailure = await service.findRequestById(
      requested.id_pasajero_ocasional,
    );
    expect(afterFailure?.estado_solicitud).toBe(
      OccasionalRequestStatus.RADICADA,
    );
    expect(afterFailure?.aprobado_en).toBeNull();
    expect(afterFailure?.aprobado_por_coordinador).toBeNull();

    const manifestAfterFailure = await service.listTripPassengerManifest(tripId);
    expect(manifestAfterFailure).toHaveLength(0);

    // Un reintento posterior sin fallo completa correctamente
    const retried = await service.approveOccasionalSeat({
      id_pasajero_ocasional: requested.id_pasajero_ocasional,
      aprobado_por_usuario: coordinatorUserId,
    });
    expect(retried.estado_solicitud).toBe(
      OccasionalRequestStatus.APROBADO_COORDINACION,
    );
    expect(await service.listTripPassengerManifest(tripId)).toHaveLength(1);
  });

  it("mitigación de riesgo: impide revertir una inasistencia si el cupo ya fue asignado a un pasajero ocasional", async () => {
    repository.registerAbsence({
      id_viaje: tripId,
      id_estudiante: regularStudentId,
      reportado_por_acudiente: intruderGuardianId,
      cupo_liberado: true,
    });

    await service.requestOccasionalSeat({
      id_viaje: tripId,
      id_estudiante: occasionalStudentId,
      solicitado_por_usuario: guardianUserId,
    });

    await expect(
      service.revertAbsence(tripId, regularStudentId),
    ).rejects.toThrow(ConflictException);
  });

  it("rechaza casos borde: coordinador de otro colegio (403), viaje inexistente (404), estudiante ya en ruta (409) y doble aprobación (409)", async () => {
    repository.registerAbsence({
      id_viaje: tripId,
      id_estudiante: regularStudentId,
      reportado_por_acudiente: intruderGuardianId,
      cupo_liberado: true,
    });

    // Viaje inexistente -> 404
    await expect(
      service.requestOccasionalSeat({
        id_viaje: makeUuid(9999),
        id_estudiante: occasionalStudentId,
        solicitado_por_usuario: guardianUserId,
      }),
    ).rejects.toThrow(NotFoundException);

    // Estudiante ya asignado regularmente a la ruta -> 409
    await expect(
      service.requestOccasionalSeat({
        id_viaje: tripId,
        id_estudiante: regularStudentId,
        solicitado_por_usuario: intruderGuardianUserId,
      }),
    ).rejects.toThrow(ConflictException);

    const requested = await service.requestOccasionalSeat({
      id_viaje: tripId,
      id_estudiante: occasionalStudentId,
      solicitado_por_usuario: guardianUserId,
    });

    // Coordinador de otro colegio -> 403
    await expect(
      service.approveOccasionalSeat({
        id_pasajero_ocasional: requested.id_pasajero_ocasional,
        aprobado_por_usuario: otherCoordUserId,
      }),
    ).rejects.toThrow(ForbiddenException);

    // Aprobación válida
    await service.approveOccasionalSeat({
      id_pasajero_ocasional: requested.id_pasajero_ocasional,
      aprobado_por_usuario: coordinatorUserId,
    });

    // Doble aprobación -> 409
    await expect(
      service.approveOccasionalSeat({
        id_pasajero_ocasional: requested.id_pasajero_ocasional,
        aprobado_por_usuario: coordinatorUserId,
      }),
    ).rejects.toThrow(ConflictException);
  });
});
