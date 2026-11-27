import { Inject, Injectable, Optional } from "@nestjs/common";
import { TripStateEnum } from "@common/enums/trip-state.enum";
import { uuidv7 } from "@common/utils/uuidv7";
import {
  ATTENDANCE_REPOSITORY,
  IAttendanceRepository,
} from "../../attendance/domain/attendance-repository.port";
import { InMemoryAttendanceRepository } from "../../attendance/infrastructure/in-memory-attendance.repository";
import { CustodyService } from "../../custody/custody.service";
import { FsmCustodyState } from "../../custody/domain/custody.types";
import { IOccasionalPassengerRepository } from "../domain/occasional-passenger-repository.port";
import {
  AbsenceIrreversibleError,
  ApproveOccasionalSeatCommand,
  ApproveOccasionalSeatResult,
  CoordinatorNotAuthorizedForTripError,
  DuplicateOccasionalRequestError,
  GuardianNotAuthorizedForStudentError,
  OccasionalBookingRulesViolationError,
  OccasionalPassengerRecord,
  OccasionalRejectionReason,
  OccasionalRequestInvalidStateError,
  OccasionalRequestNotFoundError,
  OccasionalRequestStatus,
  OccasionalStudentNotFoundError,
  OccasionalTransactionError,
  OccasionalTripNotFoundError,
  OccasionalTripNotScheduledError,
  RequestOccasionalSeatCommand,
  RequestOccasionalSeatResult,
  StudentAlreadyAssignedToRouteError,
  TripManifestEntry,
  VacancyBalanceSnapshot,
} from "../domain/occasional-passenger.types";
import { PassengerCapacityEvaluator } from "../passenger-capacity-evaluator.service";

export interface InMemoryOccasionalTrip {
  id_viaje: string;
  id_ruta: string;
  id_colegio: string;
  jornada: "MANANA" | "TARDE" | "COMPLETA";
  estado: TripStateEnum;
  hora_inicio_programada: Date;
  capacidad_nominal: number;
}

export interface InMemoryOccasionalStudent {
  id_estudiante: string;
  id_colegio: string;
  activo: boolean;
}

export interface InMemoryGuardianLink {
  id_acudiente: string;
  id_usuario: string;
  id_estudiante: string;
}

export interface InMemoryCoordinatorProfile {
  id_coordinador: string;
  id_usuario: string;
  id_colegio: string;
}

export interface InMemoryOccasionalRouteAssignment {
  id_estudiante: string;
  id_ruta: string;
  ciclo_horario: "IDA" | "RETORNO" | "AMBOS";
  activa: boolean;
}

export interface InMemoryReportedAbsence {
  id_inasistencia?: string;
  id_viaje: string;
  id_estudiante: string;
  reportado_por_acudiente: string;
  cupo_liberado: boolean;
  fecha_reporte?: Date;
}

const ACTIVE_OCCASIONAL_STATUSES = new Set<OccasionalRequestStatus>([
  OccasionalRequestStatus.RADICADA,
  OccasionalRequestStatus.APROBADO_COORDINACION,
  OccasionalRequestStatus.UTILIZADO,
]);

/**
 * Adaptador en memoria del repositorio transaccional de pasajeros ocasionales (Issue #11).
 *
 * Replica fielmente las invariantes de `V005` y `V018`:
 * - Serialización pesimista por `id_viaje` mediante cola mutex asíncrona (`withTripLock`).
 * - Evaluación conjunta de antelación >= 2h y vacante por inasistencia vía `PassengerCapacityEvaluator`.
 * - Verificación OWASP ASVS V4.1 de vínculo acudiente-estudiante y colegio del coordinador.
 * - Protección de irreversibilidad de inasistencia una vez asignado el cupo.
 * - Rollback atómico ante fallos a mitad de la aprobación / inscripción en `viaje_estudiante`.
 */
@Injectable()
export class InMemoryOccasionalPassengerRepository
  implements IOccasionalPassengerRepository
{
  private readonly capacityEvaluator: PassengerCapacityEvaluator;
  private readonly trips = new Map<string, InMemoryOccasionalTrip>();
  private readonly students = new Map<string, InMemoryOccasionalStudent>();
  private readonly guardianLinks: InMemoryGuardianLink[] = [];
  private readonly coordinators = new Map<string, InMemoryCoordinatorProfile>();
  private readonly routeAssignments: InMemoryOccasionalRouteAssignment[] = [];
  private readonly absences: Required<InMemoryReportedAbsence>[] = [];
  private readonly requests = new Map<string, OccasionalPassengerRecord>();
  private readonly manifest = new Map<string, TripManifestEntry>();
  private readonly tripLocks = new Map<string, Promise<void>>();
  private simulatedIoDelayMs = 0;
  private nextApprovalManifestFailure: Error | null = null;

  constructor(
    @Optional() capacityEvaluator?: PassengerCapacityEvaluator,
    @Optional() private readonly custodyService?: CustodyService,
    @Optional()
    @Inject(ATTENDANCE_REPOSITORY)
    private readonly attendanceRepository?: IAttendanceRepository,
  ) {
    this.capacityEvaluator =
      capacityEvaluator ?? new PassengerCapacityEvaluator();
  }

  /** Latencia artificial para probar serialización bajo concurrencia real. */
  setSimulatedIoDelayMs(delayMs: number): void {
    this.simulatedIoDelayMs = Math.max(0, delayMs);
  }

  /** Hook de prueba para simular fallo a mitad de aprobación y verificar rollback atómico. */
  setNextApprovalManifestFailure(error: Error | null): void {
    this.nextApprovalManifestFailure = error;
  }

  registerTrip(trip: InMemoryOccasionalTrip): void {
    this.trips.set(trip.id_viaje, {
      ...trip,
      hora_inicio_programada: new Date(trip.hora_inicio_programada.getTime()),
    });
  }

  registerStudent(student: InMemoryOccasionalStudent): void {
    this.students.set(student.id_estudiante, { ...student });
  }

  registerGuardianLink(link: InMemoryGuardianLink): void {
    this.guardianLinks.push({ ...link });
  }

  registerCoordinator(coordinator: InMemoryCoordinatorProfile): void {
    this.coordinators.set(coordinator.id_coordinador, { ...coordinator });
  }

  registerRouteAssignment(assignment: InMemoryOccasionalRouteAssignment): void {
    this.routeAssignments.push({ ...assignment });
  }

  registerAbsence(absence: InMemoryReportedAbsence): void {
    const existingIdx = this.absences.findIndex(
      (item) =>
        item.id_viaje === absence.id_viaje &&
        item.id_estudiante === absence.id_estudiante,
    );
    const stored: Required<InMemoryReportedAbsence> = {
      id_inasistencia: absence.id_inasistencia ?? uuidv7(),
      id_viaje: absence.id_viaje,
      id_estudiante: absence.id_estudiante,
      reportado_por_acudiente: absence.reportado_por_acudiente,
      cupo_liberado: absence.cupo_liberado,
      fecha_reporte: absence.fecha_reporte ?? new Date(),
    };
    if (existingIdx >= 0) {
      this.absences[existingIdx] = stored;
    } else {
      this.absences.push(stored);
    }
  }

  registerManifestEntry(entry: TripManifestEntry): void {
    this.manifest.set(this.manifestKey(entry.id_viaje, entry.id_estudiante), {
      ...entry,
    });
  }

  async evaluateTripVacancyBalance(
    idViaje: string,
  ): Promise<VacancyBalanceSnapshot> {
    const trip = this.trips.get(idViaje);
    if (!trip) {
      throw new OccasionalTripNotFoundError(idViaje);
    }
    return this.computeTripBalance(trip);
  }

  async requestOccasionalSeat(
    command: RequestOccasionalSeatCommand,
  ): Promise<RequestOccasionalSeatResult> {
    return this.withTripLock(command.id_viaje, async () => {
      const trip = this.trips.get(command.id_viaje);
      if (!trip) {
        throw new OccasionalTripNotFoundError(command.id_viaje);
      }

      if (trip.estado !== TripStateEnum.PROGRAMADO) {
        throw new OccasionalTripNotScheduledError(trip.id_viaje, trip.estado);
      }

      if (this.simulatedIoDelayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.simulatedIoDelayMs),
        );
      }

      const student = this.students.get(command.id_estudiante);
      if (!student || !student.activo) {
        throw new OccasionalStudentNotFoundError(command.id_estudiante);
      }

      // OWASP ASVS V4.1: verificar vínculo acudiente-estudiante del usuario solicitante
      const guardianLink = this.guardianLinks.find(
        (link) =>
          link.id_usuario === command.solicitado_por_usuario &&
          link.id_estudiante === command.id_estudiante,
      );
      if (!guardianLink) {
        throw new GuardianNotAuthorizedForStudentError(
          command.solicitado_por_usuario,
          command.id_estudiante,
        );
      }

      // Verificar que no esté ya asignado regularmente a la ruta/jornada
      if (this.isStudentRegularlyAssigned(command.id_estudiante, trip)) {
        throw new StudentAlreadyAssignedToRouteError(
          command.id_estudiante,
          trip.id_ruta,
        );
      }

      // Verificar duplicado de solicitud activa o matrícula previa en el viaje
      const hasActiveRequest = Array.from(this.requests.values()).some(
        (req) =>
          req.id_viaje === trip.id_viaje &&
          req.id_estudiante === command.id_estudiante &&
          ACTIVE_OCCASIONAL_STATUSES.has(req.estado_solicitud),
      );
      const alreadyInManifest = this.manifest.has(
        this.manifestKey(trip.id_viaje, command.id_estudiante),
      );
      if (hasActiveRequest || alreadyInManifest) {
        throw new DuplicateOccasionalRequestError(
          command.id_estudiante,
          trip.id_viaje,
        );
      }

      const balanceBefore = this.computeTripBalance(trip);
      const unallocatedAbsence = this.findNextUnallocatedAbsence(
        trip.id_viaje,
        command.id_estudiante,
      );

      const eligibility = this.capacityEvaluator.evaluateBookingEligibility({
        balance: balanceBefore,
        solicitadoEn: command.solicitado_en,
        hasUnallocatedAbsence: unallocatedAbsence !== null,
      });

      if (!eligibility.elegible || !unallocatedAbsence) {
        throw new OccasionalBookingRulesViolationError({
          motivos_rechazo: eligibility.motivos_rechazo,
          message: eligibility.mensaje,
          detalle_antelacion: eligibility.antelacion,
          balance_vacantes: balanceBefore,
        });
      }

      const now = new Date(command.solicitado_en.getTime());
      const record: OccasionalPassengerRecord = {
        id_pasajero_ocasional: uuidv7(now.getTime()),
        id_estudiante: command.id_estudiante,
        id_viaje: trip.id_viaje,
        id_ruta: trip.id_ruta,
        id_estudiante_que_libera_cupo: unallocatedAbsence.id_estudiante,
        qr_provisional_hash: command.qr_provisional_hash.trim().toLowerCase(),
        estado_solicitud: OccasionalRequestStatus.RADICADA,
        solicitado_en: now,
        solicitado_por_acudiente: guardianLink.id_acudiente,
        motivo: command.motivo?.trim() || null,
        aprobado_en: null,
        aprobado_por_coordinador: null,
      };

      this.requests.set(record.id_pasajero_ocasional, record);

      return {
        solicitud: this.cloneRequest(record),
        hora_inicio_programada: new Date(trip.hora_inicio_programada.getTime()),
        balance_vacantes: this.computeTripBalance(trip),
      };
    });
  }

  async approveOccasionalSeat(
    command: ApproveOccasionalSeatCommand,
  ): Promise<ApproveOccasionalSeatResult> {
    const existingLookup = this.requests.get(command.id_pasajero_ocasional);
    if (!existingLookup) {
      throw new OccasionalRequestNotFoundError(command.id_pasajero_ocasional);
    }

    return this.withTripLock(existingLookup.id_viaje, async () => {
      const request = this.requests.get(command.id_pasajero_ocasional);
      if (!request) {
        throw new OccasionalRequestNotFoundError(command.id_pasajero_ocasional);
      }

      const trip = this.trips.get(request.id_viaje);
      if (!trip) {
        throw new OccasionalTripNotFoundError(request.id_viaje);
      }

      if (this.simulatedIoDelayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.simulatedIoDelayMs),
        );
      }

      if (request.estado_solicitud !== OccasionalRequestStatus.RADICADA) {
        throw new OccasionalRequestInvalidStateError(
          request.id_pasajero_ocasional,
          request.estado_solicitud,
        );
      }

      if (trip.estado !== TripStateEnum.PROGRAMADO) {
        throw new OccasionalTripNotScheduledError(trip.id_viaje, trip.estado);
      }

      const coordinator = this.resolveAuthorizedCoordinator(
        command.aprobado_por_usuario,
        command.id_coordinador ?? null,
        trip.id_colegio,
      );
      if (!coordinator) {
        throw new CoordinatorNotAuthorizedForTripError(trip.id_ruta);
      }

      // Revalidar que la inasistencia liberadora sigue vigente y que no hay sobrecupo
      const absenceStillActive = this.absences.some(
        (item) =>
          item.id_viaje === trip.id_viaje &&
          item.id_estudiante === request.id_estudiante_que_libera_cupo &&
          item.cupo_liberado === true,
      );
      if (!absenceStillActive) {
        throw new OccasionalBookingRulesViolationError({
          motivos_rechazo: [
            OccasionalRejectionReason.SIN_VACANTE_POR_INASISTENCIA,
          ],
          message: `La inasistencia asociada al cupo (${request.id_estudiante_que_libera_cupo}) ya no está disponible.`,
          balance_vacantes: this.computeTripBalance(trip),
        });
      }

      const balance = this.computeTripBalance(trip);
      if (balance.ocupacion_proyectada > balance.capacidad_nominal) {
        throw new OccasionalBookingRulesViolationError({
          motivos_rechazo: [
            OccasionalRejectionReason.CAPACIDAD_NOMINAL_AGOTADA,
          ],
          message: `Aprobar la solicitud excedería la capacidad nominal del vehículo (${balance.ocupacion_proyectada}/${balance.capacidad_nominal}).`,
          balance_vacantes: balance,
        });
      }

      const mKey = this.manifestKey(trip.id_viaje, request.id_estudiante);
      if (this.manifest.has(mKey)) {
        throw new DuplicateOccasionalRequestError(
          request.id_estudiante,
          trip.id_viaje,
        );
      }

      // Snapshot previo para rollback atómico ante cualquier fallo a mitad de operación
      const previousRequestSnapshot = this.cloneRequest(request);
      const now = new Date();
      const manifestEntry: TripManifestEntry = {
        id_viaje: trip.id_viaje,
        id_estudiante: request.id_estudiante,
        estado_custodia: FsmCustodyState.NO_INICIADO,
        es_pasajero_ocasional: true,
      };

      try {
        // Paso 1: Transicionar solicitud a APROBADO_COORDINACION
        request.estado_solicitud =
          OccasionalRequestStatus.APROBADO_COORDINACION;
        request.aprobado_en = now;
        request.aprobado_por_coordinador = coordinator.id_coordinador;

        // Paso 2: Simular fallo inyectado (si una prueba verifica rollback transaccional)
        if (this.nextApprovalManifestFailure) {
          const failure = this.nextApprovalManifestFailure;
          this.nextApprovalManifestFailure = null;
          throw failure;
        }

        // Paso 3: Inclusión automática en viaje_estudiante (y sincronización con Custody/Attendance)
        this.manifest.set(mKey, manifestEntry);

        if (this.custodyService) {
          await this.custodyService.enrollStudentInTrip(
            trip.id_viaje,
            request.id_estudiante,
            true,
          );
        }

        if (this.attendanceRepository instanceof InMemoryAttendanceRepository) {
          this.attendanceRepository.registerOccasionalPass({
            id_pasajero_ocasional: request.id_pasajero_ocasional,
            id_viaje: trip.id_viaje,
            id_estudiante: request.id_estudiante,
            qr_provisional_hash: request.qr_provisional_hash,
            estado_solicitud: "APROBADO_COORDINACION",
          });
        }

        return {
          solicitud: this.cloneRequest(request),
          lista_asistencia: { ...manifestEntry },
          balance_vacantes: this.computeTripBalance(trip),
        };
      } catch (error) {
        // ROLLBACK ATÓMICO: restaurar solicitud a RADICADA y deshacer inserción en viaje_estudiante
        this.requests.set(
          previousRequestSnapshot.id_pasajero_ocasional,
          previousRequestSnapshot,
        );
        this.manifest.delete(mKey);
        if (error instanceof OccasionalTransactionError) {
          throw error;
        }
        throw new OccasionalTransactionError(
          `Transacción revertida al aprobar pasajero ocasional ${command.id_pasajero_ocasional}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
  }

  async revertAbsence(idViaje: string, idEstudiante: string): Promise<void> {
    return this.withTripLock(idViaje, async () => {
      const idx = this.absences.findIndex(
        (item) =>
          item.id_viaje === idViaje && item.id_estudiante === idEstudiante,
      );
      if (idx < 0) {
        return;
      }

      const isAllocated = Array.from(this.requests.values()).some(
        (req) =>
          req.id_viaje === idViaje &&
          req.id_estudiante_que_libera_cupo === idEstudiante &&
          ACTIVE_OCCASIONAL_STATUSES.has(req.estado_solicitud),
      );

      if (isAllocated) {
        throw new AbsenceIrreversibleError(idEstudiante, idViaje);
      }

      this.absences.splice(idx, 1);
    });
  }

  async findRequestById(
    idPasajeroOcasional: string,
  ): Promise<OccasionalPassengerRecord | null> {
    const found = this.requests.get(idPasajeroOcasional);
    return found ? this.cloneRequest(found) : null;
  }

  async listTripPassengerManifest(
    idViaje: string,
  ): Promise<TripManifestEntry[]> {
    return Array.from(this.manifest.values())
      .filter((entry) => entry.id_viaje === idViaje)
      .map((entry) => ({ ...entry }));
  }

  private computeTripBalance(
    trip: InMemoryOccasionalTrip,
  ): VacancyBalanceSnapshot {
    const assignedStudentIds = new Set<string>();
    for (const assignment of this.routeAssignments) {
      if (
        assignment.id_ruta === trip.id_ruta &&
        assignment.activa &&
        this.matchesTripJornada(assignment.ciclo_horario, trip.jornada)
      ) {
        const st = this.students.get(assignment.id_estudiante);
        if (!st || st.activo) {
          assignedStudentIds.add(assignment.id_estudiante);
        }
      }
    }

    const inasistenciasReportadas = this.absences.filter(
      (item) => item.id_viaje === trip.id_viaje && item.cupo_liberado === true,
    ).length;

    const ocasionalesActivos = Array.from(this.requests.values()).filter(
      (req) =>
        req.id_viaje === trip.id_viaje &&
        ACTIVE_OCCASIONAL_STATUSES.has(req.estado_solicitud),
    ).length;

    return this.capacityEvaluator.calculateVacancyBalance({
      id_viaje: trip.id_viaje,
      id_ruta: trip.id_ruta,
      estado_viaje: trip.estado,
      hora_inicio_programada: trip.hora_inicio_programada,
      capacidad_nominal: trip.capacidad_nominal,
      estudiantes_asignados: assignedStudentIds.size,
      inasistencias_reportadas: inasistenciasReportadas,
      ocasionales_activos: ocasionalesActivos,
    });
  }

  private findNextUnallocatedAbsence(
    idViaje: string,
    requestingStudentId: string,
  ): Required<InMemoryReportedAbsence> | null {
    const allocatedLiberators = new Set<string>(
      Array.from(this.requests.values())
        .filter(
          (req) =>
            req.id_viaje === idViaje &&
            ACTIVE_OCCASIONAL_STATUSES.has(req.estado_solicitud),
        )
        .map((req) => req.id_estudiante_que_libera_cupo),
    );

    const candidates = this.absences
      .filter(
        (item) =>
          item.id_viaje === idViaje &&
          item.cupo_liberado === true &&
          item.id_estudiante !== requestingStudentId &&
          !allocatedLiberators.has(item.id_estudiante),
      )
      .sort((a, b) => a.fecha_reporte.getTime() - b.fecha_reporte.getTime());

    return candidates[0] ?? null;
  }

  private isStudentRegularlyAssigned(
    idEstudiante: string,
    trip: InMemoryOccasionalTrip,
  ): boolean {
    return this.routeAssignments.some(
      (assignment) =>
        assignment.id_estudiante === idEstudiante &&
        assignment.id_ruta === trip.id_ruta &&
        assignment.activa &&
        this.matchesTripJornada(assignment.ciclo_horario, trip.jornada),
    );
  }

  private matchesTripJornada(
    ciclo: "IDA" | "RETORNO" | "AMBOS",
    jornada: "MANANA" | "TARDE" | "COMPLETA",
  ): boolean {
    return (
      ciclo === "AMBOS" ||
      jornada === "COMPLETA" ||
      (jornada === "MANANA" && ciclo === "IDA") ||
      (jornada === "TARDE" && ciclo === "RETORNO")
    );
  }

  private resolveAuthorizedCoordinator(
    idUsuario: string,
    idCoordinador: string | null,
    idColegioRuta: string,
  ): InMemoryCoordinatorProfile | null {
    for (const coordinator of this.coordinators.values()) {
      const matchesUser = coordinator.id_usuario === idUsuario;
      const matchesId =
        idCoordinador === null || coordinator.id_coordinador === idCoordinador;
      const matchesSchool = coordinator.id_colegio === idColegioRuta;
      if (matchesUser && matchesId && matchesSchool) {
        return coordinator;
      }
    }
    return null;
  }

  private manifestKey(idViaje: string, idEstudiante: string): string {
    return `${idViaje}:${idEstudiante}`;
  }

  private cloneRequest(
    record: OccasionalPassengerRecord,
  ): OccasionalPassengerRecord {
    return {
      ...record,
      solicitado_en: new Date(record.solicitado_en.getTime()),
      aprobado_en: record.aprobado_en
        ? new Date(record.aprobado_en.getTime())
        : null,
    };
  }

  private async withTripLock<T>(
    idViaje: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.tripLocks.get(idViaje) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.tripLocks.set(idViaje, chained);

    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tripLocks.get(idViaje) === chained) {
        this.tripLocks.delete(idViaje);
      }
    }
  }
}
