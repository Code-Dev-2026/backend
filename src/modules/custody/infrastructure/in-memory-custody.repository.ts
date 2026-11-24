import { Injectable } from "@nestjs/common";
import * as crypto from "crypto";
import { TripStateEnum } from "@common/enums/trip-state.enum";
import { uuidv7 } from "@common/utils/uuidv7";
import {
  ICustodyRepository,
  PersistCustodyTransitionInput,
  PersistCustodyTransitionResult,
} from "../domain/custody-repository.port";
import { CustodyStateMachine } from "../domain/custody-state-machine";
import {
  CUSTODY_GENESIS_HASH,
  CustodyChainVerificationReport,
  CustodyEnrollmentNotFoundError,
  CustodyHistoryRecord,
  CustodyIntegrityCheckRow,
  FsmCustodyState,
  InvalidCustodyCoordinatesError,
  MorningInitializationEntry,
  MorningInitializationSummary,
  StudentTripCustodyRecord,
  TripClosureBlockedError,
  TripCustodyMeta,
  TripDirection,
  WormImmutabilityViolationError,
} from "../domain/custody.types";

export interface InMemoryRouteContract {
  id_ruta: string;
  id_estudiante: string;
  ciclo_horario: "IDA" | "RETORNO" | "AMBOS";
  activo: boolean;
}

/**
 * Formatea una fecha UTC con precisión de microsegundos exactamente como
 * `to_char(fecha_hora AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` en PostgreSQL (V006).
 */
export function formatCustodyUtcIso(date: Date): string {
  const iso = date.toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
  return `${iso.slice(0, -1)}000Z`;
}

/**
 * Calcula el hash SHA-256 canónico de un evento de custodia con la misma fórmula
 * que `fn_encadenar_hash_custodia()` y `fn_verificar_integridad_custodia()` (V006).
 */
export function computeCustodyEventHash(params: {
  secuencia: number;
  prevHash: string;
  fechaHora: Date;
  idEstudiante: string;
  idViaje: string;
  estadoOrigen: string;
  estadoDestino: string;
  disparadorEvento: string;
  registradoPorUsuario: string | null;
}): string {
  const payload = [
    String(params.secuencia),
    params.prevHash,
    formatCustodyUtcIso(params.fechaHora),
    params.idEstudiante,
    params.idViaje,
    params.estadoOrigen,
    params.estadoDestino,
    params.disparadorEvento,
    params.registradoPorUsuario ?? "SISTEMA",
  ].join("|");

  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Adaptador en memoria del repositorio de custodia y ledger WORM.
 * Replica con fidelidad las invariantes de `V006`, `V008` y `V014` para
 * pruebas unitarias, HTTP y operación local sin PostgreSQL activo.
 */
@Injectable()
export class InMemoryCustodyRepository implements ICustodyRepository {
  private readonly fsm = new CustodyStateMachine();
  private readonly trips = new Map<string, TripCustodyMeta>();
  private readonly enrollments = new Map<string, StudentTripCustodyRecord>();
  private readonly history: CustodyHistoryRecord[] = [];
  private readonly routeContracts: InMemoryRouteContract[] = [];

  private enrollmentKey(idViaje: string, idEstudiante: string): string {
    return `${idViaje}:${idEstudiante}`;
  }

  /** Helper para registrar contratos activos de ruta en pruebas del job matutino. */
  registerRouteContract(contract: InMemoryRouteContract): void {
    this.routeContracts.push({ ...contract });
  }

  async registerTrip(trip: TripCustodyMeta): Promise<TripCustodyMeta> {
    const stored: TripCustodyMeta = {
      ...trip,
      hora_fin_real: trip.hora_fin_real ?? null,
    };
    this.trips.set(trip.id_viaje, stored);
    return { ...stored };
  }

  async findTripById(idViaje: string): Promise<TripCustodyMeta | null> {
    const found = this.trips.get(idViaje);
    return found ? { ...found } : null;
  }

  async enrollStudentInTrip(
    idViaje: string,
    idEstudiante: string,
    initialState: FsmCustodyState = FsmCustodyState.NO_INICIADO,
    esPasajeroOcasional = false,
  ): Promise<StudentTripCustodyRecord> {
    const key = this.enrollmentKey(idViaje, idEstudiante);
    const existing = this.enrollments.get(key);
    if (existing) {
      return { ...existing };
    }

    const now = new Date();
    const record: StudentTripCustodyRecord = {
      id_viaje: idViaje,
      id_estudiante: idEstudiante,
      estado_custodia: initialState,
      es_pasajero_ocasional: esPasajeroOcasional,
      hora_abordaje:
        initialState === FsmCustodyState.A_BORDO_VEHICULO ? now : null,
      hora_desembarque:
        initialState === FsmCustodyState.EN_COLEGIO ||
        initialState === FsmCustodyState.ENTREGADO_ACUDIENTE
          ? now
          : null,
      actualizado_en: now,
    };

    this.enrollments.set(key, record);
    return { ...record };
  }

  async getStudentTripState(
    idViaje: string,
    idEstudiante: string,
  ): Promise<StudentTripCustodyRecord | null> {
    const record = this.enrollments.get(
      this.enrollmentKey(idViaje, idEstudiante),
    );
    return record ? { ...record } : null;
  }

  async listTripCustodyStates(
    idViaje: string,
  ): Promise<StudentTripCustodyRecord[]> {
    const results: StudentTripCustodyRecord[] = [];
    for (const record of this.enrollments.values()) {
      if (record.id_viaje === idViaje) {
        results.push({ ...record });
      }
    }
    return results;
  }

  async listStudentsByState(
    idViaje: string,
    state: FsmCustodyState,
  ): Promise<StudentTripCustodyRecord[]> {
    const results: StudentTripCustodyRecord[] = [];
    for (const record of this.enrollments.values()) {
      if (record.id_viaje === idViaje && record.estado_custodia === state) {
        results.push({ ...record });
      }
    }
    return results;
  }

  async applyTransitionAndAppendHistory(
    input: PersistCustodyTransitionInput,
  ): Promise<PersistCustodyTransitionResult> {
    if (input.coordenadas) {
      const { latitud, longitud } = input.coordenadas;
      if (
        !Number.isFinite(latitud) ||
        !Number.isFinite(longitud) ||
        latitud < -90 ||
        latitud > 90 ||
        longitud < -180 ||
        longitud > 180
      ) {
        throw new InvalidCustodyCoordinatesError(
          `Coordenadas WGS84 inválidas: (${latitud}, ${longitud}).`,
        );
      }
    }

    const key = this.enrollmentKey(input.id_viaje, input.id_estudiante);
    const current = this.enrollments.get(key);
    if (!current) {
      throw new CustodyEnrollmentNotFoundError(
        input.id_viaje,
        input.id_estudiante,
      );
    }

    // Defensa en profundidad: el repositorio también valida el invariante FSM antes de mutar nada
    const outcome = this.fsm.transition({
      currentState: current.estado_custodia,
      targetState: input.estado_destino,
      tripDirection: input.tipo_recorrido,
      disparador_evento: input.disparador_evento,
    });

    const now = new Date();
    const updated: StudentTripCustodyRecord = {
      ...current,
      estado_custodia: outcome.toState,
      hora_abordaje: outcome.setsHoraAbordaje
        ? (current.hora_abordaje ?? now)
        : current.hora_abordaje,
      hora_desembarque: outcome.setsHoraDesembarque
        ? now
        : current.hora_desembarque,
      actualizado_en: now,
    };

    const previousRecord = this.history[this.history.length - 1];
    const secuencia = previousRecord ? previousRecord.secuencia + 1 : 1;
    const prevHash = previousRecord
      ? previousRecord.hash_sha256_actual
      : CUSTODY_GENESIS_HASH;

    const registradoPor = input.registrado_por_usuario ?? null;
    const hashActual = computeCustodyEventHash({
      secuencia,
      prevHash,
      fechaHora: now,
      idEstudiante: input.id_estudiante,
      idViaje: input.id_viaje,
      estadoOrigen: outcome.fromState,
      estadoDestino: outcome.toState,
      disparadorEvento: outcome.disparador_evento,
      registradoPorUsuario: registradoPor,
    });

    const historyEntry: CustodyHistoryRecord = Object.freeze({
      id_historial: uuidv7(now.getTime()),
      secuencia,
      id_estudiante: input.id_estudiante,
      id_viaje: input.id_viaje,
      estado_origen: outcome.fromState,
      estado_destino: outcome.toState,
      disparador_evento: outcome.disparador_evento,
      coordenadas_gps: input.coordenadas
        ? Object.freeze({ ...input.coordenadas })
        : null,
      fecha_hora: now,
      registrado_por_usuario: registradoPor,
      hash_sha256_anterior: prevHash,
      hash_sha256_actual: hashActual,
    });

    this.enrollments.set(key, updated);
    this.history.push(historyEntry);

    return {
      custody: { ...updated },
      history: {
        ...historyEntry,
        coordenadas_gps: historyEntry.coordenadas_gps
          ? { ...historyEntry.coordenadas_gps }
          : null,
      },
    };
  }

  /** Simula el bloqueo WORM de PostgreSQL (V008) ante UPDATE/DELETE/TRUNCATE. */
  attemptMutateHistory(): never {
    throw new WormImmutabilityViolationError();
  }

  async listHistoryByTrip(idViaje: string): Promise<CustodyHistoryRecord[]> {
    return this.history
      .filter((entry) => entry.id_viaje === idViaje)
      .map((entry) => ({
        ...entry,
        coordenadas_gps: entry.coordenadas_gps
          ? { ...entry.coordenadas_gps }
          : null,
      }));
  }

  async listHistoryByStudent(
    idEstudiante: string,
    limit = 100,
  ): Promise<CustodyHistoryRecord[]> {
    const safeLimit = Math.max(1, Math.min(limit, 1000));
    return this.history
      .filter((entry) => entry.id_estudiante === idEstudiante)
      .slice(-safeLimit)
      .reverse()
      .map((entry) => ({
        ...entry,
        coordenadas_gps: entry.coordenadas_gps
          ? { ...entry.coordenadas_gps }
          : null,
      }));
  }

  async verifyHistoryIntegrity(
    limit = 10000,
  ): Promise<CustodyChainVerificationReport> {
    const safeLimit = Math.max(1, Math.min(limit, 50000));
    const slice = this.history.slice(0, safeLimit);
    let expectedPrevHash = CUSTODY_GENESIS_HASH;
    let cadenaIntegra = true;
    let secuenciaFallo: number | null = null;
    const registros: CustodyIntegrityCheckRow[] = [];

    for (const row of slice) {
      const expectedHash = computeCustodyEventHash({
        secuencia: row.secuencia,
        prevHash: expectedPrevHash,
        fechaHora: row.fecha_hora,
        idEstudiante: row.id_estudiante,
        idViaje: row.id_viaje,
        estadoOrigen: row.estado_origen,
        estadoDestino: row.estado_destino,
        disparadorEvento: row.disparador_evento,
        registradoPorUsuario: row.registrado_por_usuario,
      });

      const esValido =
        expectedHash === row.hash_sha256_actual &&
        row.hash_sha256_anterior === expectedPrevHash;

      if (!esValido && secuenciaFallo === null) {
        cadenaIntegra = false;
        secuenciaFallo = row.secuencia;
      }

      registros.push({
        secuencia: row.secuencia,
        es_valido: esValido,
        hash_esperado: expectedHash,
        hash_encontrado: row.hash_sha256_actual,
      });

      expectedPrevHash = row.hash_sha256_actual;
    }

    return {
      total_verificados: registros.length,
      cadena_integra: cadenaIntegra,
      secuencia_fallo: secuenciaFallo,
      registros,
    };
  }

  async initializeMorningCustody(
    fecha: string,
  ): Promise<MorningInitializationSummary> {
    const created: MorningInitializationEntry[] = [];

    for (const trip of this.trips.values()) {
      if (
        trip.fecha !== fecha ||
        (trip.estado !== TripStateEnum.PROGRAMADO &&
          trip.estado !== TripStateEnum.EN_CURSO)
      ) {
        continue;
      }

      const matchingContracts = this.routeContracts.filter(
        (c) =>
          c.activo &&
          c.id_ruta === trip.id_ruta &&
          (c.ciclo_horario === "AMBOS" ||
            (trip.tipo_recorrido === TripDirection.MANANA &&
              c.ciclo_horario === "IDA") ||
            (trip.tipo_recorrido === TripDirection.TARDE &&
              c.ciclo_horario === "RETORNO")),
      );

      for (const contract of matchingContracts) {
        const key = this.enrollmentKey(trip.id_viaje, contract.id_estudiante);
        if (this.enrollments.has(key)) {
          continue;
        }
        const enrolled = await this.enrollStudentInTrip(
          trip.id_viaje,
          contract.id_estudiante,
          FsmCustodyState.NO_INICIADO,
        );
        created.push({
          id_viaje: enrolled.id_viaje,
          id_estudiante: enrolled.id_estudiante,
          estado_custodia: enrolled.estado_custodia,
        });
      }
    }

    return {
      fecha,
      registros_inicializados: created.length,
      registros: created,
    };
  }

  async finalizeTrip(idViaje: string): Promise<TripCustodyMeta> {
    const [studentsOnBoard, studentsInReturn] = await Promise.all([
      this.listStudentsByState(idViaje, FsmCustodyState.A_BORDO_VEHICULO),
      this.listStudentsByState(
        idViaje,
        FsmCustodyState.RETORNO_SEDE_POR_FALLA_ENTREGA,
      ),
    ]);

    const blockingStudents = [...studentsOnBoard, ...studentsInReturn];

    if (blockingStudents.length > 0) {
      throw new TripClosureBlockedError(
        idViaje,
        blockingStudents.length,
        blockingStudents.map((s) => s.id_estudiante),
      );
    }

    const existing = this.trips.get(idViaje);
    const finalized: TripCustodyMeta = existing
      ? {
          ...existing,
          estado: TripStateEnum.FINALIZADO,
          hora_fin_real: existing.hora_fin_real ?? new Date(),
        }
      : {
          id_viaje: idViaje,
          id_ruta: "",
          fecha: new Date().toISOString().slice(0, 10),
          tipo_recorrido: TripDirection.MANANA,
          estado: TripStateEnum.FINALIZADO,
          hora_fin_real: new Date(),
        };

    this.trips.set(idViaje, finalized);
    return { ...finalized };
  }
}
