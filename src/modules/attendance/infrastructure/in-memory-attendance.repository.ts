import { Inject, Injectable, Optional } from "@nestjs/common";
import * as crypto from "crypto";
import { TripStateEnum } from "@common/enums/trip-state.enum";
import { uuidv7 } from "@common/utils/uuidv7";
import { CustodyService } from "../../custody/custody.service";
import {
  FsmCustodyState,
  TripDirection,
} from "../../custody/domain/custody.types";
import {
  IJudicialAlertRepository,
  JUDICIAL_ALERT_REPOSITORY,
} from "../../custody/judicial-alerts/domain/judicial-alert-repository.port";
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
import {
  ActiveJudicialAlertRecord,
  AtomicDisembarkCommand,
  AtomicDisembarkRecord,
  AuthorizationExpiredError,
  AuthorizedAdultsLimitExceededError,
  CoordinatorUnauthorizedError,
  CustodyActaRecord,
  DeliveryRecord,
  DisembarkOutcomeType,
  DisembarkResultCode,
  DuplicateDisembarkError,
  FailedDeliveryRecordNotFoundError,
  FinalizeSchoolCustodyCommand,
  FinalizeSchoolCustodyRecord,
  IncompatibleTripDirectionError,
  JudicialAlertBlockedError,
  MAX_ACTIVE_AUTHORIZED_ADULTS,
  ReceptorInactiveOrRevokedError,
  ReceptorType,
  ReceptorUnauthorizedError,
  SchoolCoordinatorRecord,
  SchoolCustodyAlreadyFinalizedError,
  StudentAuthorizedAdultLink,
  StudentGuardianLink,
  StudentNotFoundError,
  StudentNotInSchoolReturnError,
  StudentNotOnBoardError,
  StudentReceptorDirectory,
} from "../domain/disembark.types";

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
  id_colegio?: string | null;
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
  tipo_evento: "ABORDAJE" | "DESCENSO";
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
  private readonly disembarkAttendanceByTripStudent = new Map<
    string,
    StoredAttendanceRecord
  >();
  private readonly attendanceByIdempotencyKey = new Map<
    string,
    StoredAttendanceRecord
  >();
  private readonly deliveries: DeliveryRecord[] = [];
  private readonly deliveryByIdempotencyKey = new Map<string, DeliveryRecord>();
  private readonly custodyActasByDelivery = new Map<
    string,
    CustodyActaRecord
  >();
  private readonly guardianLinks: StudentGuardianLink[] = [];
  private readonly authorizedAdultLinks: StudentAuthorizedAdultLink[] = [];
  private readonly judicialAlerts: ActiveJudicialAlertRecord[] = [];
  private readonly coordinatorsById = new Map<
    string,
    SchoolCoordinatorRecord
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
    @Optional()
    @Inject(JUDICIAL_ALERT_REPOSITORY)
    private readonly judicialAlertRepository?: IJudicialAlertRepository,
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

  registerGuardianLink(link: StudentGuardianLink): void {
    this.guardianLinks.push({
      ...link,
      documento_blind_index: link.documento_blind_index.trim().toLowerCase(),
    });
  }

  /**
   * Registra un vínculo de adulto autorizado aplicando RN-04 (máximo 3 activos por menor),
   * espejo de `trg_limite_autorizados` (V003). `bypassLimitCheck` solo se usa en pruebas
   * para simular anomalías de datos y verificar la defensa fail-safe en entrega.
   */
  registerAuthorizedAdultLink(
    link: StudentAuthorizedAdultLink,
    bypassLimitCheck = false,
  ): void {
    if (!bypassLimitCheck && link.autorizacion_activa) {
      const currentActive = this.authorizedAdultLinks.filter(
        (existing) =>
          existing.id_estudiante === link.id_estudiante &&
          existing.autorizacion_activa &&
          existing.id_autorizado !== link.id_autorizado,
      ).length;
      if (currentActive >= MAX_ACTIVE_AUTHORIZED_ADULTS) {
        throw new AuthorizedAdultsLimitExceededError(
          link.id_estudiante,
          currentActive + 1,
        );
      }
    }

    this.authorizedAdultLinks.push({
      ...link,
      documento_blind_index: link.documento_blind_index.trim().toLowerCase(),
    });
  }

  registerJudicialAlert(alert: ActiveJudicialAlertRecord): void {
    this.judicialAlerts.push({
      ...alert,
      individuo_blind_index: alert.individuo_blind_index.trim().toLowerCase(),
    });
  }

  registerSchoolCoordinator(coordinator: SchoolCoordinatorRecord): void {
    this.coordinatorsById.set(coordinator.id_coordinador, { ...coordinator });
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

  async getTripDirection(idViaje: string): Promise<"MANANA" | "TARDE" | null> {
    const trip = this.trips.get(idViaje);
    if (!trip) {
      return null;
    }
    return trip.jornada === "TARDE" ? "TARDE" : "MANANA";
  }

  async getStudentReceptorDirectory(
    idEstudiante: string,
  ): Promise<StudentReceptorDirectory | null> {
    const student = this.studentsById.get(idEstudiante);
    if (!student) {
      return null;
    }

    const alertsMap = new Map<string, ActiveJudicialAlertRecord>();
    for (const localAlert of this.judicialAlerts) {
      if (localAlert.id_estudiante === idEstudiante) {
        alertsMap.set(localAlert.id_alerta, { ...localAlert });
      }
    }

    if (this.judicialAlertRepository) {
      const storeAlerts = await this.judicialAlertRepository.listByStudent(
        idEstudiante,
        false,
      );
      for (const stored of storeAlerts) {
        alertsMap.set(stored.id_alerta, {
          id_alerta: stored.id_alerta,
          id_estudiante: stored.id_estudiante,
          radicado_medida: stored.radicado_medida,
          individuo_blind_index: stored.documento_restringido_hash,
          activa: stored.activa,
          eliminado_soft: stored.eliminado_soft,
        });
      }
    }

    return {
      id_estudiante: student.id_estudiante,
      id_colegio: student.id_colegio ?? null,
      activo: student.activo,
      acudientes: this.guardianLinks
        .filter((g) => g.id_estudiante === idEstudiante)
        .sort((a, b) => {
          if (a.es_tutor_principal !== b.es_tutor_principal) {
            return a.es_tutor_principal ? -1 : 1;
          }
          return a.orden_notificacion - b.orden_notificacion;
        })
        .map((g) => ({ ...g })),
      autorizados: this.authorizedAdultLinks
        .filter((a) => a.id_estudiante === idEstudiante)
        .map((a) => ({ ...a })),
      alertas_judiciales: Array.from(alertsMap.values()),
    };
  }

  async getSchoolCoordinator(
    idCoordinador: string,
  ): Promise<SchoolCoordinatorRecord | null> {
    const coordinator = this.coordinatorsById.get(idCoordinador);
    return coordinator ? { ...coordinator } : null;
  }

  async registerAtomicDisembark(
    command: AtomicDisembarkCommand,
  ): Promise<AtomicDisembarkRecord> {
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

    return this.withTripLock(command.id_viaje, async () => {
      const trip = this.trips.get(command.id_viaje);
      if (!trip) {
        throw new TripNotFoundError(command.id_viaje);
      }

      if (trip.estado !== TripStateEnum.EN_CURSO) {
        throw new TripNotInProgressError(trip.id_viaje, trip.estado);
      }

      if (this.simulatedIoDelayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.simulatedIoDelayMs),
        );
      }

      const student = this.studentsById.get(command.id_estudiante);
      if (!student || !student.activo) {
        throw new StudentNotFoundError(command.id_estudiante);
      }

      const now = new Date();
      const idempotencyKey = command.idempotency_key?.trim() || null;
      const key = this.tripStudentKey(trip.id_viaje, student.id_estudiante);

      // 1. Control idempotente sobre entrega
      if (idempotencyKey) {
        const existingDelivery =
          this.deliveryByIdempotencyKey.get(idempotencyKey);
        if (existingDelivery) {
          const existingDisembark =
            this.disembarkAttendanceByTripStudent.get(
              this.tripStudentKey(
                existingDelivery.id_viaje,
                existingDelivery.id_estudiante,
              ),
            ) ?? null;

          return {
            aprobado:
              existingDelivery.estado_entrega ===
              DisembarkOutcomeType.ENTREGADO_EXITOSO,
            codigo:
              existingDelivery.estado_entrega ===
              DisembarkOutcomeType.ENTREGADO_EXITOSO
                ? DisembarkResultCode.DESCENSO_EXITOSO
                : DisembarkResultCode.DESEMBARQUE_FALLIDO_RETORNO,
            mensaje:
              "Solicitud procesada previamente por clave idempotente; sin cambios adicionales en aforo ni custodia.",
            id_viaje: existingDelivery.id_viaje,
            id_ruta: trip.id_ruta,
            id_estudiante: existingDelivery.id_estudiante,
            id_entrega: existingDelivery.id_entrega,
            id_asistencia: existingDisembark?.id_asistencia ?? null,
            id_incidente: null,
            tipo_receptor: existingDelivery.tipo_receptor,
            id_acudiente_receptor: existingDelivery.id_acudiente,
            id_autorizado_receptor: existingDelivery.id_autorizado,
            estado_entrega: existingDelivery.estado_entrega,
            estado_custodia:
              this.custodyStateByTripStudent.get(key) ??
              FsmCustodyState.A_BORDO_VEHICULO,
            metodo_validacion: command.metodo_validacion,
            total_a_bordo: trip.total_a_bordo,
            capacidad_nominal: trip.capacidad_nominal,
            id_acudientes_notificados: [],
            id_notificacion_principal: null,
            duplicado_por_idempotencia: true,
            fecha_hora: existingDelivery.fecha_hora,
          };
        }
      }

      // 2. Verificar que el estudiante esté A_BORDO_VEHICULO
      const currentState = await this.resolveCurrentCustodyState(
        trip.id_viaje,
        student.id_estudiante,
      );
      if (currentState !== FsmCustodyState.A_BORDO_VEHICULO) {
        throw new StudentNotOnBoardError(
          student.id_estudiante,
          trip.id_viaje,
          currentState ?? "NO_MATRICULADO",
        );
      }

      const direction =
        trip.jornada === "TARDE" ? TripDirection.TARDE : TripDirection.MANANA;
      const guardianIds = this.resolveStudentGuardianIds(student);
      const nextAttempt =
        this.deliveries
          .filter(
            (d) =>
              d.id_viaje === trip.id_viaje &&
              d.id_estudiante === student.id_estudiante,
          )
          .reduce((max, d) => Math.max(max, d.intento_secuencia), 0) + 1;

      // 3A. DESEMBARQUE_FALLIDO_RETORNO (RF-11): NO decrementar total_a_bordo
      if (
        command.resultado_entrega ===
        DisembarkOutcomeType.DESEMBARQUE_FALLIDO_RETORNO
      ) {
        if (direction !== TripDirection.TARDE) {
          throw new IncompatibleTripDirectionError(
            "El protocolo DESEMBARQUE_FALLIDO_RETORNO solo aplica en recorridos de TARDE.",
          );
        }

        const observaciones =
          command.observaciones_fallido?.trim() ||
          "Ningún adulto autorizado compareció en la parada; se activa retorno seguro a sede escolar.";

        const delivery: DeliveryRecord = {
          id_entrega: uuidv7(now.getTime()),
          id_viaje: trip.id_viaje,
          id_estudiante: student.id_estudiante,
          intento_secuencia: nextAttempt,
          tipo_receptor: "RETORNO_SEDE_ESCOLAR",
          id_acudiente: null,
          id_autorizado: null,
          estado_entrega: DisembarkOutcomeType.DESEMBARQUE_FALLIDO_RETORNO,
          foto_evidencia_url: command.foto_evidencia_url,
          coordenadas: { ...command.coordenadas },
          observaciones_fallido: observaciones,
          idempotency_key: idempotencyKey,
          fecha_hora: now,
        };
        this.deliveries.push(delivery);
        if (idempotencyKey) {
          this.deliveryByIdempotencyKey.set(idempotencyKey, delivery);
        }

        await this.syncCustodyFsmTransition(
          trip.id_viaje,
          student.id_estudiante,
          FsmCustodyState.RETORNO_SEDE_POR_FALLA_ENTREGA,
          TripDirection.TARDE,
          "DESEMBARQUE_FALLIDO_RETORNO",
          command.registrado_por_usuario,
          command.coordenadas,
        );
        this.custodyStateByTripStudent.set(
          key,
          FsmCustodyState.RETORNO_SEDE_POR_FALLA_ENTREGA,
        );

        const incident = await this.recordIncident({
          id_viaje: trip.id_viaje,
          id_estudiante: student.id_estudiante,
          tipo_incidente: "DESEMBARQUE_FALLIDO_RETORNO",
          severidad: "CRITICO",
          descripcion: observaciones,
          coordenadas: command.coordenadas,
          registrado_por_usuario: command.registrado_por_usuario,
        });

        return {
          aprobado: false,
          codigo: DisembarkResultCode.DESEMBARQUE_FALLIDO_RETORNO,
          mensaje: `Protocolo de retorno seguro a sede activado: el estudiante ${student.id_estudiante} permanece a bordo (${trip.total_a_bordo}/${trip.capacidad_nominal}).`,
          id_viaje: trip.id_viaje,
          id_ruta: trip.id_ruta,
          id_estudiante: student.id_estudiante,
          id_entrega: delivery.id_entrega,
          id_asistencia: null,
          id_incidente: incident.id_incidente,
          tipo_receptor: "RETORNO_SEDE_ESCOLAR",
          id_acudiente_receptor: null,
          id_autorizado_receptor: null,
          estado_entrega: DisembarkOutcomeType.DESEMBARQUE_FALLIDO_RETORNO,
          estado_custodia: FsmCustodyState.RETORNO_SEDE_POR_FALLA_ENTREGA,
          metodo_validacion: command.metodo_validacion,
          total_a_bordo: trip.total_a_bordo, // Sin decremento (RF-11)
          capacidad_nominal: trip.capacidad_nominal,
          id_acudientes_notificados: guardianIds,
          id_notificacion_principal:
            guardianIds.length > 0 ? uuidv7(now.getTime()) : null,
          duplicado_por_idempotencia: false,
          fecha_hora: now,
        };
      }

      // 3B. ENTREGADO_EXITOSO: defensa en profundidad de receptor en el repositorio
      const tipoReceptor = command.tipo_receptor;
      if (!tipoReceptor) {
        throw new ReceptorUnauthorizedError(
          student.id_estudiante,
          "El tipo de receptor es obligatorio para entrega exitosa.",
        );
      }

      let idAcudienteReceptor: string | null = null;
      let idAutorizadoReceptor: string | null = null;
      let targetState: FsmCustodyState;

      if (tipoReceptor === ReceptorType.SEDE_EDUCATIVA) {
        if (direction !== TripDirection.MANANA) {
          throw new IncompatibleTripDirectionError(
            "La entrega directa en SEDE_EDUCATIVA solo aplica en recorridos de MANANA.",
          );
        }
        targetState = FsmCustodyState.EN_COLEGIO;
      } else {
        if (direction !== TripDirection.TARDE) {
          throw new IncompatibleTripDirectionError(
            `La entrega a '${tipoReceptor}' solo aplica en recorridos de TARDE.`,
          );
        }

        const blindIndex =
          command.receptor_documento_blind_index?.trim().toLowerCase() ?? null;
        if (!blindIndex) {
          throw new ReceptorUnauthorizedError(student.id_estudiante);
        }

        const activeJudicial = this.judicialAlerts.find(
          (al) =>
            al.id_estudiante === student.id_estudiante &&
            al.activa &&
            !al.eliminado_soft &&
            al.individuo_blind_index === blindIndex,
        );
        if (activeJudicial) {
          throw new JudicialAlertBlockedError(
            student.id_estudiante,
            activeJudicial.radicado_medida,
            { idAlerta: activeJudicial.id_alerta },
          );
        }

        if (this.judicialAlertRepository) {
          const storeJudicial =
            await this.judicialAlertRepository.findActiveMatchByBlindIndex(
              student.id_estudiante,
              blindIndex,
            );
          if (storeJudicial) {
            throw new JudicialAlertBlockedError(
              student.id_estudiante,
              storeJudicial.radicado_medida,
              {
                idAlerta: storeJudicial.id_alerta,
                juzgadoEmisor: storeJudicial.juzgado_emisor,
              },
            );
          }
        }

        if (tipoReceptor === ReceptorType.ACUDIENTE) {
          const guardian = this.guardianLinks.find(
            (g) =>
              g.id_estudiante === student.id_estudiante &&
              g.documento_blind_index === blindIndex &&
              (!command.id_receptor || g.id_acudiente === command.id_receptor),
          );
          if (!guardian) {
            throw new ReceptorUnauthorizedError(student.id_estudiante);
          }
          idAcudienteReceptor = guardian.id_acudiente;
        } else {
          const activeCount = this.authorizedAdultLinks.filter(
            (a) =>
              a.id_estudiante === student.id_estudiante &&
              a.autorizacion_activa &&
              a.adulto_activo &&
              !a.expediente_revocado &&
              (a.autorizado_hasta === null || a.autorizado_hasta > now),
          ).length;

          if (activeCount > MAX_ACTIVE_AUTHORIZED_ADULTS) {
            throw new AuthorizedAdultsLimitExceededError(
              student.id_estudiante,
              activeCount,
            );
          }

          const auth = this.authorizedAdultLinks.find(
            (a) =>
              a.id_estudiante === student.id_estudiante &&
              a.documento_blind_index === blindIndex &&
              (!command.id_receptor || a.id_autorizado === command.id_receptor),
          );
          if (!auth) {
            throw new ReceptorUnauthorizedError(student.id_estudiante);
          }
          if (
            !auth.adulto_activo ||
            !auth.autorizacion_activa ||
            auth.expediente_revocado
          ) {
            throw new ReceptorInactiveOrRevokedError(student.id_estudiante);
          }
          if (auth.autorizado_hasta && auth.autorizado_hasta <= now) {
            throw new AuthorizationExpiredError(
              student.id_estudiante,
              auth.autorizado_hasta,
            );
          }
          idAutorizadoReceptor = auth.id_autorizado;
        }

        targetState = FsmCustodyState.ENTREGADO_ACUDIENTE;
      }

      if (this.disembarkAttendanceByTripStudent.has(key)) {
        throw new DuplicateDisembarkError(trip.id_viaje, student.id_estudiante);
      }

      if (trip.total_a_bordo <= 0) {
        throw new RangeError(
          `Aforo inconsistente en viaje ${trip.id_viaje}: total_a_bordo=${trip.total_a_bordo}.`,
        );
      }

      // Liberar 1 cupo atómicamente
      trip.total_a_bordo -= 1;

      const disembarkAttendance: StoredAttendanceRecord = {
        id_asistencia: uuidv7(now.getTime()),
        id_viaje: trip.id_viaje,
        id_estudiante: student.id_estudiante,
        tipo_evento: "DESCENSO",
        metodo_validacion: command.metodo_validacion,
        idempotency_key: idempotencyKey,
        fecha_hora: now,
      };
      this.disembarkAttendanceByTripStudent.set(key, disembarkAttendance);

      const delivery: DeliveryRecord = {
        id_entrega: uuidv7(now.getTime()),
        id_viaje: trip.id_viaje,
        id_estudiante: student.id_estudiante,
        intento_secuencia: nextAttempt,
        tipo_receptor: tipoReceptor,
        id_acudiente: idAcudienteReceptor,
        id_autorizado: idAutorizadoReceptor,
        estado_entrega: DisembarkOutcomeType.ENTREGADO_EXITOSO,
        foto_evidencia_url: command.foto_evidencia_url,
        coordenadas: { ...command.coordenadas },
        observaciones_fallido: null,
        idempotency_key: idempotencyKey,
        fecha_hora: now,
      };
      this.deliveries.push(delivery);
      if (idempotencyKey) {
        this.deliveryByIdempotencyKey.set(idempotencyKey, delivery);
      }

      const triggerEvent =
        tipoReceptor === ReceptorType.SEDE_EDUCATIVA
          ? "DESEMBARQUE_SEDE_EDUCATIVA"
          : tipoReceptor === ReceptorType.ACUDIENTE
            ? "ENTREGA_ACUDIENTE"
            : "ENTREGA_ADULTO_AUTORIZADO";

      await this.syncCustodyFsmTransition(
        trip.id_viaje,
        student.id_estudiante,
        targetState,
        direction,
        triggerEvent,
        command.registrado_por_usuario,
        command.coordenadas,
      );
      this.custodyStateByTripStudent.set(key, targetState);

      return {
        aprobado: true,
        codigo: DisembarkResultCode.DESCENSO_EXITOSO,
        mensaje: `Descenso y entrega registrados exitosamente (${trip.total_a_bordo}/${trip.capacidad_nominal} pasajeros a bordo).`,
        id_viaje: trip.id_viaje,
        id_ruta: trip.id_ruta,
        id_estudiante: student.id_estudiante,
        id_entrega: delivery.id_entrega,
        id_asistencia: disembarkAttendance.id_asistencia,
        id_incidente: null,
        tipo_receptor: tipoReceptor,
        id_acudiente_receptor: idAcudienteReceptor,
        id_autorizado_receptor: idAutorizadoReceptor,
        estado_entrega: DisembarkOutcomeType.ENTREGADO_EXITOSO,
        estado_custodia: targetState,
        metodo_validacion: command.metodo_validacion,
        total_a_bordo: trip.total_a_bordo,
        capacidad_nominal: trip.capacidad_nominal,
        id_acudientes_notificados: guardianIds,
        id_notificacion_principal:
          guardianIds.length > 0 ? uuidv7(now.getTime()) : null,
        duplicado_por_idempotencia: false,
        fecha_hora: now,
      };
    });
  }

  async finalizeSchoolCustody(
    command: FinalizeSchoolCustodyCommand,
  ): Promise<FinalizeSchoolCustodyRecord> {
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

    return this.withTripLock(command.id_viaje, async () => {
      const trip = this.trips.get(command.id_viaje);
      if (!trip) {
        throw new TripNotFoundError(command.id_viaje);
      }

      if (trip.estado !== TripStateEnum.EN_CURSO) {
        throw new TripNotInProgressError(trip.id_viaje, trip.estado);
      }

      const student = this.studentsById.get(command.id_estudiante);
      if (!student || !student.activo) {
        throw new StudentNotFoundError(command.id_estudiante);
      }

      const coordinator = this.coordinatorsById.get(
        command.recibido_por_coordinador,
      );
      if (
        !coordinator ||
        (student.id_colegio && coordinator.id_colegio !== student.id_colegio)
      ) {
        throw new CoordinatorUnauthorizedError(
          command.recibido_por_coordinador,
          student.id_estudiante,
        );
      }

      const key = this.tripStudentKey(trip.id_viaje, student.id_estudiante);
      const currentState = await this.resolveCurrentCustodyState(
        trip.id_viaje,
        student.id_estudiante,
      );
      if (currentState !== FsmCustodyState.RETORNO_SEDE_POR_FALLA_ENTREGA) {
        throw new StudentNotInSchoolReturnError(
          student.id_estudiante,
          trip.id_viaje,
          currentState ?? "NO_MATRICULADO",
        );
      }

      const failedDelivery = [...this.deliveries]
        .reverse()
        .find(
          (d) =>
            d.id_viaje === trip.id_viaje &&
            d.id_estudiante === student.id_estudiante &&
            d.estado_entrega ===
              DisembarkOutcomeType.DESEMBARQUE_FALLIDO_RETORNO,
        );

      if (!failedDelivery) {
        throw new FailedDeliveryRecordNotFoundError(
          trip.id_viaje,
          student.id_estudiante,
        );
      }

      if (this.custodyActasByDelivery.has(failedDelivery.id_entrega)) {
        throw new SchoolCustodyAlreadyFinalizedError(failedDelivery.id_entrega);
      }

      if (trip.total_a_bordo <= 0) {
        throw new RangeError(
          `Aforo inconsistente en viaje ${trip.id_viaje}: total_a_bordo=${trip.total_a_bordo}.`,
        );
      }

      const now = new Date();
      // Decrementar total_a_bordo ÚNICAMENTE al certificar recepción formal en sede
      trip.total_a_bordo -= 1;

      const disembarkAttendance: StoredAttendanceRecord = {
        id_asistencia: uuidv7(now.getTime()),
        id_viaje: trip.id_viaje,
        id_estudiante: student.id_estudiante,
        tipo_evento: "DESCENSO",
        metodo_validacion: "VERIFICACION_VISUAL_PARADA",
        idempotency_key: command.idempotency_key?.trim() || null,
        fecha_hora: now,
      };
      this.disembarkAttendanceByTripStudent.set(key, disembarkAttendance);

      const obs = command.observaciones?.trim() || null;
      const firmaDigitalHash = crypto
        .createHash("sha256")
        .update(
          [
            failedDelivery.id_entrega,
            student.id_estudiante,
            coordinator.id_coordinador,
            now.toISOString(),
            obs ?? "RECEPCION_FORMAL_SEDE",
          ].join("|"),
          "utf8",
        )
        .digest("hex");

      const acta: CustodyActaRecord = {
        id_acta: uuidv7(now.getTime()),
        id_entrega: failedDelivery.id_entrega,
        id_estudiante: student.id_estudiante,
        recibido_por_coordinador: coordinator.id_coordinador,
        fecha_recepcion: now,
        firma_digital_hash: firmaDigitalHash,
        observaciones: obs,
      };
      this.custodyActasByDelivery.set(failedDelivery.id_entrega, acta);

      await this.syncCustodyFsmTransition(
        trip.id_viaje,
        student.id_estudiante,
        FsmCustodyState.EN_COLEGIO,
        TripDirection.TARDE,
        "RECEPCION_SEDE_COORDINACION",
        command.registrado_por_usuario,
        command.coordenadas,
      );
      this.custodyStateByTripStudent.set(key, FsmCustodyState.EN_COLEGIO);

      const guardianIds = this.resolveStudentGuardianIds(student);

      return {
        finalizado: true,
        codigo: DisembarkResultCode.CUSTODIA_SEDE_FINALIZADA,
        mensaje: `Custodia en sede certificada formalmente con acta ${acta.id_acta} (${trip.total_a_bordo}/${trip.capacidad_nominal} pasajeros a bordo).`,
        id_viaje: trip.id_viaje,
        id_ruta: trip.id_ruta,
        id_estudiante: student.id_estudiante,
        id_entrega: failedDelivery.id_entrega,
        id_acta: acta.id_acta,
        id_asistencia: disembarkAttendance.id_asistencia,
        recibido_por_coordinador: coordinator.id_coordinador,
        firma_digital_hash: firmaDigitalHash,
        estado_custodia: FsmCustodyState.EN_COLEGIO,
        total_a_bordo: trip.total_a_bordo,
        capacidad_nominal: trip.capacidad_nominal,
        id_acudientes_notificados: guardianIds,
        id_notificacion_principal:
          guardianIds.length > 0 ? uuidv7(now.getTime()) : null,
        fecha_recepcion: now,
      };
    });
  }

  async listStudentDeliveries(
    idViaje: string,
    idEstudiante?: string,
  ): Promise<DeliveryRecord[]> {
    return this.deliveries
      .filter(
        (d) =>
          d.id_viaje === idViaje &&
          (!idEstudiante || d.id_estudiante === idEstudiante),
      )
      .map((d) => ({ ...d, coordenadas: { ...d.coordenadas } }));
  }

  async getCustodyActaByDelivery(
    idEntrega: string,
  ): Promise<CustodyActaRecord | null> {
    const acta = this.custodyActasByDelivery.get(idEntrega);
    return acta ? { ...acta } : null;
  }

  private resolveStudentGuardianIds(
    student: InMemoryAttendanceStudent,
  ): string[] {
    const linked = this.guardianLinks
      .filter((g) => g.id_estudiante === student.id_estudiante)
      .sort((a, b) => {
        if (a.es_tutor_principal !== b.es_tutor_principal) {
          return a.es_tutor_principal ? -1 : 1;
        }
        return a.orden_notificacion - b.orden_notificacion;
      })
      .map((g) => g.id_acudiente);

    if (
      student.id_acudiente_titular &&
      !linked.includes(student.id_acudiente_titular)
    ) {
      linked.push(student.id_acudiente_titular);
    }

    return linked;
  }

  private async resolveCurrentCustodyState(
    idViaje: string,
    idEstudiante: string,
  ): Promise<FsmCustodyState | null> {
    if (this.custodyService) {
      try {
        const detail = await this.custodyService.getStudentTripCustody(
          idViaje,
          idEstudiante,
        );
        return detail.estado_custodia;
      } catch {
        // fallback al estado local si no estaba en CustodyService
      }
    }

    return (
      this.custodyStateByTripStudent.get(
        this.tripStudentKey(idViaje, idEstudiante),
      ) ?? null
    );
  }

  private async syncCustodyFsmTransition(
    idViaje: string,
    idEstudiante: string,
    targetState: FsmCustodyState,
    direction: TripDirection,
    disparadorEvento: string,
    registradoPorUsuario: string | null,
    coordenadas: { latitud: number; longitud: number },
  ): Promise<void> {
    if (!this.custodyService) {
      return;
    }

    await this.custodyService.executeTransition({
      id_viaje: idViaje,
      id_estudiante: idEstudiante,
      estado_destino: targetState,
      tipo_recorrido: direction,
      disparador_evento: disparadorEvento,
      registrado_por_usuario: registradoPorUsuario,
      latitud: coordenadas.latitud,
      longitud: coordenadas.longitud,
    });
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
