import { Injectable, Optional } from "@nestjs/common";
import { TripStateEnum } from "@common/enums/trip-state.enum";
import { uuidv7 } from "@common/utils/uuidv7";
import { CustodyService } from "../../custody/custody.service";
import {
  FsmCustodyState,
  TripDirection,
} from "../../custody/domain/custody.types";
import { CapacityEnforcer } from "../capacity-enforcer.service";
import { IAttendanceRepository } from "../domain/attendance-repository.port";
import {
  AtomicBoardingCommand,
  AtomicBoardingRecord,
  BoardingResultCode,
  BoardingValidationMethod,
  CreateOperationalIncidentInput,
  InvalidAttendanceCoordinatesError,
  InvalidQrTokenError,
  OperationalIncidentRecord,
  StudentNotAssignedToRouteError,
  TripNotFoundError,
  TripNotInProgressError,
  TripOccupancySummary,
} from "../domain/attendance.types";

export interface InMemoryAttendanceTrip {
  id_viaje: string;
  id_ruta: string;
  estado: TripStateEnum;
  jornada: "MANANA" | "TARDE" | "COMPLETA";
  capacidad_nominal: number;
  total_a_bordo: number;
}

export interface InMemoryAttendanceStudent {
  id_estudiante: string;
  activo: boolean;
  qr_token_hash: string;
  id_acudiente_titular?: string | null;
}

export interface InMemoryRouteAssignment {
  id_estudiante: string;
  id_ruta: string;
  ciclo_horario: "IDA" | "RETORNO" | "AMBOS";
  activa: boolean;
}

export interface InMemoryOccasionalPass {
  id_pasajero_ocasional: string;
  id_viaje: string;
  id_estudiante: string;
  qr_provisional_hash: string;
  estado_solicitud:
    | "RADICADA"
    | "APROBADO_COORDINACION"
    | "RECHAZADA"
    | "UTILIZADO";
}

interface StoredAttendanceRecord {
  id_asistencia: string;
  id_viaje: string;
  id_estudiante: string;
  tipo_evento: "ABORDAJE";
  metodo_validacion: BoardingValidationMethod;
  idempotency_key: string | null;
  fecha_hora: Date;
}

/**
 * Adaptador en memoria del repositorio de asistencia atómica (Issue #8).
 *
 * Replica fielmente las invariantes de `fn_registrar_abordaje_atomico` (V015):
 * - Bloqueo pesimista por viaje mediante cola mutex asíncrona (`withTripLock`),
 *   serializando operaciones concurrentes sobre el mismo `id_viaje` (ASVS V11.1).
 * - Control anti-sobrecupo estricto vía `CapacityEnforcer` (RN-02).
 * - Restricción única `(id_viaje, id_estudiante, 'ABORDAJE')` y clave idempotente (RN-05).
 * - Inserción automática de incidentes en rechazos no fatales (`DENEGADO_SOBRECUPO`, `ABORDAJE_PREVIO_EXISTE`).
 * - Sincronización opcional con `CustodyService` (Issue #7) para mantener FSM y WORM coherentes.
 */
@Injectable()
export class InMemoryAttendanceRepository implements IAttendanceRepository {
  private readonly capacityEnforcer: CapacityEnforcer;
  private readonly trips = new Map<string, InMemoryAttendanceTrip>();
  private readonly studentsById = new Map<string, InMemoryAttendanceStudent>();
  private readonly studentIdByQrHash = new Map<string, string>();
  private readonly routeAssignments: InMemoryRouteAssignment[] = [];
  private readonly occasionalPasses: InMemoryOccasionalPass[] = [];
  private readonly attendanceByTripStudent = new Map<
    string,
    StoredAttendanceRecord
  >();
  private readonly attendanceByIdempotencyKey = new Map<
    string,
    StoredAttendanceRecord
  >();
  private readonly custodyStateByTripStudent = new Map<
    string,
    FsmCustodyState
  >();
  private readonly incidents: OperationalIncidentRecord[] = [];
  private readonly tripLocks = new Map<string, Promise<void>>();
  private simulatedIoDelayMs = 0;

  constructor(
    @Optional() capacityEnforcer?: CapacityEnforcer,
    @Optional() private readonly custodyService?: CustodyService,
  ) {
    this.capacityEnforcer = capacityEnforcer ?? new CapacityEnforcer();
  }

  /**
   * Permite inyectar una latencia asíncrona artificial en pruebas de concurrencia
   * para demostrar que la serialización por viaje resiste interleaving real de eventos.
   */
  setSimulatedIoDelayMs(delayMs: number): void {
    this.simulatedIoDelayMs = Math.max(0, delayMs);
  }

  registerTrip(trip: InMemoryAttendanceTrip): void {
    this.trips.set(trip.id_viaje, { ...trip });
  }

  registerStudent(student: InMemoryAttendanceStudent): void {
    const normalizedHash = student.qr_token_hash.trim().toLowerCase();
    this.studentsById.set(student.id_estudiante, {
      ...student,
      qr_token_hash: normalizedHash,
    });
    this.studentIdByQrHash.set(normalizedHash, student.id_estudiante);
  }

  registerRouteAssignment(assignment: InMemoryRouteAssignment): void {
    this.routeAssignments.push({ ...assignment });
  }

  registerOccasionalPass(pass: InMemoryOccasionalPass): void {
    this.occasionalPasses.push({
      ...pass,
      qr_provisional_hash: pass.qr_provisional_hash.trim().toLowerCase(),
    });
  }

  async registerAtomicBoarding(
    command: AtomicBoardingCommand,
  ): Promise<AtomicBoardingRecord> {
    const { latitud, longitud } = command.coordenadas;
    if (
      !Number.isFinite(latitud) ||
      !Number.isFinite(longitud) ||
      latitud < -90 ||
      latitud > 90 ||
      longitud < -180 ||
      longitud > 180
    ) {
      throw new InvalidAttendanceCoordinatesError(
        `Coordenadas WGS84 inválidas: (${latitud}, ${longitud}).`,
      );
    }

    // Serialización estricta a nivel de fila `viaje` (espejo de SELECT ... FOR UPDATE OF v)
    return this.withTripLock(command.id_viaje, async () => {
      const trip = this.trips.get(command.id_viaje);
      if (!trip) {
        throw new TripNotFoundError(command.id_viaje);
      }

      if (trip.estado !== TripStateEnum.EN_CURSO) {
        throw new TripNotInProgressError(trip.id_viaje, trip.estado);
      }

      // Simulación opcional de I/O asíncrono dentro de la sección crítica protegida
      if (this.simulatedIoDelayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.simulatedIoDelayMs),
        );
      }

      const resolved = this.resolveStudentAndMethod(command);
      const isAssigned = this.isStudentAuthorizedForTrip(
        resolved.student.id_estudiante,
        trip,
        resolved.occasionalPass !== null,
      );

      if (!isAssigned) {
        throw new StudentNotAssignedToRouteError(
          resolved.student.id_estudiante,
          trip.id_viaje,
        );
      }

      const now = new Date();
      const idempotencyKey = command.idempotency_key?.trim() || null;
      const attendanceKey = this.tripStudentKey(
        trip.id_viaje,
        resolved.student.id_estudiante,
      );

      // 1. Verificación de clave idempotente y doble abordaje (RN-05)
      let existingAttendance: StoredAttendanceRecord | undefined;
      let duplicateByIdempotency = false;

      if (idempotencyKey) {
        existingAttendance = this.attendanceByIdempotencyKey.get(idempotencyKey);
        if (existingAttendance) {
          duplicateByIdempotency = true;
        }
      }

      if (!existingAttendance) {
        existingAttendance = this.attendanceByTripStudent.get(attendanceKey);
      }

      if (existingAttendance) {
        const incident = await this.recordIncident({
          id_viaje: trip.id_viaje,
          id_estudiante: resolved.student.id_estudiante,
          tipo_incidente: "DOBLE_ABORDAJE_DETECTADO",
          severidad: "ADVERTENCIA",
          descripcion: duplicateByIdempotency
            ? `Reintento duplicado bloqueado por clave idempotente (${idempotencyKey}) para estudiante ${resolved.student.id_estudiante} en viaje ${trip.id_viaje} (RN-05).`
            : `Doble abordaje rechazado (RN-05): el estudiante ${resolved.student.id_estudiante} ya registra abordaje previo en el viaje ${trip.id_viaje}.`,
          coordenadas: command.coordenadas,
          registrado_por_usuario: command.registrado_por_usuario,
        });

        return {
          aprobado: false,
          codigo: BoardingResultCode.ABORDAJE_PREVIO_EXISTE,
          mensaje: `El estudiante ${resolved.student.id_estudiante} ya registra abordaje previo en el viaje ${trip.id_viaje} (RN-05).`,
          id_viaje: trip.id_viaje,
          id_ruta: trip.id_ruta,
          id_estudiante: resolved.student.id_estudiante,
          id_asistencia: existingAttendance.id_asistencia,
          id_incidente: incident.id_incidente,
          id_acudiente_titular: null,
          id_notificacion: null,
          estado_custodia:
            this.custodyStateByTripStudent.get(attendanceKey) ??
            FsmCustodyState.A_BORDO_VEHICULO,
          metodo_validacion: resolved.metodo_validacion,
          total_a_bordo: trip.total_a_bordo,
          capacidad_nominal: trip.capacidad_nominal,
          duplicado_por_idempotencia: duplicateByIdempotency,
          fecha_hora: now,
        };
      }

      // 2. Evaluación atómica de cupo nominal físico (RN-02)
      const capacity = this.capacityEnforcer.evaluateBoardingCapacity(
        trip.total_a_bordo,
        trip.capacidad_nominal,
      );

      if (!capacity.permitido) {
        const incident = await this.recordIncident({
          id_viaje: trip.id_viaje,
          id_estudiante: resolved.student.id_estudiante,
          tipo_incidente: "INTENTO_SOBRECUPO",
          severidad: "CRITICO",
          descripcion: `Abordaje denegado por sobrecupo (RN-02): el vehículo alcanzó su capacidad homologada (${trip.total_a_bordo}/${trip.capacidad_nominal} pasajeros).`,
          coordenadas: command.coordenadas,
          registrado_por_usuario: command.registrado_por_usuario,
        });

        return {
          aprobado: false,
          codigo: BoardingResultCode.DENEGADO_SOBRECUPO,
          mensaje: capacity.mensaje,
          id_viaje: trip.id_viaje,
          id_ruta: trip.id_ruta,
          id_estudiante: resolved.student.id_estudiante,
          id_asistencia: null,
          id_incidente: incident.id_incidente,
          id_acudiente_titular: null,
          id_notificacion: null,
          estado_custodia:
            this.custodyStateByTripStudent.get(attendanceKey) ??
            FsmCustodyState.NO_INICIADO,
          metodo_validacion: resolved.metodo_validacion,
          total_a_bordo: trip.total_a_bordo,
          capacidad_nominal: trip.capacidad_nominal,
          duplicado_por_idempotencia: false,
          fecha_hora: now,
        };
      }

      // 3. Incremento atómico del contador e inserción del registro de asistencia
      trip.total_a_bordo = capacity.total_proyectado;
      const idAsistencia = uuidv7(now.getTime());

      const storedAttendance: StoredAttendanceRecord = {
        id_asistencia: idAsistencia,
        id_viaje: trip.id_viaje,
        id_estudiante: resolved.student.id_estudiante,
        tipo_evento: "ABORDAJE",
        metodo_validacion: resolved.metodo_validacion,
        idempotency_key: idempotencyKey,
        fecha_hora: now,
      };
      this.attendanceByTripStudent.set(attendanceKey, storedAttendance);
      if (idempotencyKey) {
        this.attendanceByIdempotencyKey.set(idempotencyKey, storedAttendance);
      }

      if (
        resolved.occasionalPass &&
        resolved.occasionalPass.estado_solicitud === "APROBADO_COORDINACION"
      ) {
        resolved.occasionalPass.estado_solicitud = "UTILIZADO";
      }

      // 4. Sincronización con máquina de estados FSM de custodia (Issue #7)
      await this.syncCustodyFsmToBoarded(
        trip,
        resolved.student.id_estudiante,
        resolved.occasionalPass !== null,
        command,
      );
      this.custodyStateByTripStudent.set(
        attendanceKey,
        FsmCustodyState.A_BORDO_VEHICULO,
      );

      const idAcudienteTitular = resolved.student.id_acudiente_titular ?? null;
      const idNotificacion = idAcudienteTitular ? uuidv7(now.getTime()) : null;

      return {
        aprobado: true,
        codigo: BoardingResultCode.ABORDAJE_EXITOSO,
        mensaje: `Abordaje registrado exitosamente (${trip.total_a_bordo}/${trip.capacidad_nominal} pasajeros a bordo).`,
        id_viaje: trip.id_viaje,
        id_ruta: trip.id_ruta,
        id_estudiante: resolved.student.id_estudiante,
        id_asistencia: idAsistencia,
        id_incidente: null,
        id_acudiente_titular: idAcudienteTitular,
        id_notificacion: idNotificacion,
        estado_custodia: FsmCustodyState.A_BORDO_VEHICULO,
        metodo_validacion: resolved.metodo_validacion,
        total_a_bordo: trip.total_a_bordo,
        capacidad_nominal: trip.capacidad_nominal,
        duplicado_por_idempotencia: false,
        fecha_hora: now,
      };
    });
  }

  async recordIncident(
    input: CreateOperationalIncidentInput,
  ): Promise<OperationalIncidentRecord> {
    const now = new Date();
    const record: OperationalIncidentRecord = {
      id_incidente: uuidv7(now.getTime()),
      id_viaje: input.id_viaje,
      id_estudiante: input.id_estudiante,
      tipo_incidente: input.tipo_incidente,
      severidad: input.severidad,
      descripcion: input.descripcion,
      coordenadas: input.coordenadas ? { ...input.coordenadas } : null,
      fecha_hora: now,
      registrado_por_usuario: input.registrado_por_usuario ?? null,
    };
    this.incidents.push(record);
    return {
      ...record,
      coordenadas: record.coordenadas ? { ...record.coordenadas } : null,
    };
  }

  async listTripIncidents(
    idViaje: string,
  ): Promise<OperationalIncidentRecord[]> {
    return this.incidents
      .filter((item) => item.id_viaje === idViaje)
      .map((item) => ({
        ...item,
        coordenadas: item.coordenadas ? { ...item.coordenadas } : null,
      }));
  }

  async getTripOccupancy(
    idViaje: string,
  ): Promise<TripOccupancySummary | null> {
    const trip = this.trips.get(idViaje);
    if (!trip) {
      return null;
    }

    return {
      id_viaje: trip.id_viaje,
      id_ruta: trip.id_ruta,
      estado: trip.estado,
      total_a_bordo: trip.total_a_bordo,
      capacidad_nominal: trip.capacidad_nominal,
    };
  }

  private resolveStudentAndMethod(command: AtomicBoardingCommand): {
    student: InMemoryAttendanceStudent;
    metodo_validacion: BoardingValidationMethod;
    occasionalPass: InMemoryOccasionalPass | null;
  } {
    if (command.id_estudiante) {
      const student = this.studentsById.get(command.id_estudiante);
      if (!student || !student.activo) {
        throw new InvalidQrTokenError(
          "QR_INVALIDO",
          `El estudiante '${command.id_estudiante}' no existe o se encuentra inactivo.`,
        );
      }
      return {
        student,
        metodo_validacion: command.metodo_validacion,
        occasionalPass: null,
      };
    }

    const qrHash = command.qr_token_hash?.trim().toLowerCase();
    if (!qrHash) {
      throw new InvalidQrTokenError(
        "QR_INVALIDO",
        "Token QR no proporcionado o inválido.",
      );
    }

    const matchedStudentId = this.studentIdByQrHash.get(qrHash);
    if (matchedStudentId) {
      const student = this.studentsById.get(matchedStudentId);
      if (student && student.activo) {
        return {
          student,
          metodo_validacion: "QR_INSTITUCIONAL",
          occasionalPass: null,
        };
      }
    }

    const pass = this.occasionalPasses.find(
      (p) =>
        p.qr_provisional_hash === qrHash &&
        p.id_viaje === command.id_viaje &&
        (p.estado_solicitud === "APROBADO_COORDINACION" ||
          p.estado_solicitud === "UTILIZADO"),
    );

    if (pass) {
      const student = this.studentsById.get(pass.id_estudiante);
      if (student && student.activo) {
        return {
          student,
          metodo_validacion: "QR_OCASIONAL_TEMPORAL",
          occasionalPass: pass,
        };
      }
    }

    throw new InvalidQrTokenError(
      "QR_INVALIDO",
      "El código QR no corresponde a un estudiante activo ni a un pase ocasional aprobado para este viaje.",
    );
  }

  private isStudentAuthorizedForTrip(
    idEstudiante: string,
    trip: InMemoryAttendanceTrip,
    hasOccasionalPass: boolean,
  ): boolean {
    if (hasOccasionalPass) {
      return true;
    }

    const hasAssignment = this.routeAssignments.some(
      (a) =>
        a.activa &&
        a.id_estudiante === idEstudiante &&
        a.id_ruta === trip.id_ruta &&
        (a.ciclo_horario === "AMBOS" ||
          (trip.jornada === "MANANA" && a.ciclo_horario === "IDA") ||
          (trip.jornada === "TARDE" && a.ciclo_horario === "RETORNO") ||
          trip.jornada === "COMPLETA"),
    );

    if (hasAssignment) {
      return true;
    }

    return this.occasionalPasses.some(
      (p) =>
        p.id_viaje === trip.id_viaje &&
        p.id_estudiante === idEstudiante &&
        (p.estado_solicitud === "APROBADO_COORDINACION" ||
          p.estado_solicitud === "UTILIZADO"),
    );
  }

  private async syncCustodyFsmToBoarded(
    trip: InMemoryAttendanceTrip,
    idEstudiante: string,
    esPasajeroOcasional: boolean,
    command: AtomicBoardingCommand,
  ): Promise<void> {
    if (!this.custodyService) {
      return;
    }

    const direction =
      trip.jornada === "TARDE" ? TripDirection.TARDE : TripDirection.MANANA;

    const enrolled = await this.custodyService.enrollStudentInTrip(
      trip.id_viaje,
      idEstudiante,
      esPasajeroOcasional,
    );

    let currentState = enrolled.estado_custodia;

    if (currentState === FsmCustodyState.NO_INICIADO) {
      const toWaiting = await this.custodyService.executeTransition({
        id_viaje: trip.id_viaje,
        id_estudiante: idEstudiante,
        estado_destino: FsmCustodyState.EN_ESPERA_ABORDAJE,
        tipo_recorrido: direction,
        disparador_evento: "LLEGADA_PARADA_ABORDAJE",
        registrado_por_usuario: command.registrado_por_usuario,
        latitud: command.coordenadas.latitud,
        longitud: command.coordenadas.longitud,
      });
      currentState = toWaiting.custody.estado_custodia;
    }

    if (currentState !== FsmCustodyState.A_BORDO_VEHICULO) {
      await this.custodyService.executeTransition({
        id_viaje: trip.id_viaje,
        id_estudiante: idEstudiante,
        estado_destino: FsmCustodyState.A_BORDO_VEHICULO,
        tipo_recorrido: direction,
        disparador_evento: "ABORDAJE_QR",
        registrado_por_usuario: command.registrado_por_usuario,
        latitud: command.coordenadas.latitud,
        longitud: command.coordenadas.longitud,
      });
    }
  }

  private tripStudentKey(idViaje: string, idEstudiante: string): string {
    return `${idViaje}:${idEstudiante}`;
  }

  private async withTripLock<T>(
    idViaje: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.tripLocks.get(idViaje) ?? Promise.resolve();
    let releaseLock!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const tail = previous.then(() => current);
    this.tripLocks.set(idViaje, tail);

    await previous;
    try {
      return await operation();
    } finally {
      releaseLock();
      if (this.tripLocks.get(idViaje) === tail) {
        this.tripLocks.delete(idViaje);
      }
    }
  }
}
