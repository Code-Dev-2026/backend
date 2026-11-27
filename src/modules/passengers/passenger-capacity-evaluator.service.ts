import { Injectable } from "@nestjs/common";
import { TripStateEnum } from "@common/enums/trip-state.enum";
import {
  LeadTimeEvaluation,
  OccasionalEligibilityEvaluation,
  OccasionalRejectionReason,
  VacancyBalanceSnapshot,
} from "./domain/occasional-passenger.types";

export const MINIMUM_LEAD_TIME_HOURS = 2;
export const MINIMUM_LEAD_TIME_MINUTES = MINIMUM_LEAD_TIME_HOURS * 60;
export const MINIMUM_LEAD_TIME_MS = MINIMUM_LEAD_TIME_MINUTES * 60 * 1000;

export interface VacancyCalculationInput {
  id_viaje: string;
  id_ruta: string;
  estado_viaje: TripStateEnum | string;
  hora_inicio_programada: Date;
  capacidad_nominal: number;
  estudiantes_asignados: number;
  inasistencias_reportadas: number;
  ocasionales_activos: number;
}

/**
 * Servicio SRP especializado exclusivamente en:
 * 1. Calcular el balance de vacantes netas del viaje (RF-05, RN-03):
 *    (estudiantes_asignados - inasistencias_reportadas) + ocasionales_activos < capacidad_nominal
 *    condicionado a la existencia de al menos una inasistencia previa liberada.
 * 2. Evaluar la restricción temporal de antelación mínima de 2 horas respecto a
 *    `viaje.hora_inicio_programada`.
 */
@Injectable()
export class PassengerCapacityEvaluator {
  assertValidCounters(
    input: Pick<
      VacancyCalculationInput,
      | "capacidad_nominal"
      | "estudiantes_asignados"
      | "inasistencias_reportadas"
      | "ocasionales_activos"
    >,
  ): void {
    if (
      !Number.isInteger(input.capacidad_nominal) ||
      input.capacidad_nominal <= 0
    ) {
      throw new RangeError(
        `capacidad_nominal inválida (${input.capacidad_nominal}): debe ser un entero positivo.`,
      );
    }
    if (
      !Number.isInteger(input.estudiantes_asignados) ||
      input.estudiantes_asignados < 0
    ) {
      throw new RangeError(
        `estudiantes_asignados inválido (${input.estudiantes_asignados}): debe ser un entero >= 0.`,
      );
    }
    if (
      !Number.isInteger(input.inasistencias_reportadas) ||
      input.inasistencias_reportadas < 0
    ) {
      throw new RangeError(
        `inasistencias_reportadas inválido (${input.inasistencias_reportadas}): debe ser un entero >= 0.`,
      );
    }
    if (
      !Number.isInteger(input.ocasionales_activos) ||
      input.ocasionales_activos < 0
    ) {
      throw new RangeError(
        `ocasionales_activos inválido (${input.ocasionales_activos}): debe ser un entero >= 0.`,
      );
    }
  }

  calculateVacancyBalance(
    input: VacancyCalculationInput,
  ): VacancyBalanceSnapshot {
    this.assertValidCounters(input);

    const ocupacionBase = Math.max(
      0,
      input.estudiantes_asignados - input.inasistencias_reportadas,
    );
    const ocupacionProyectada = ocupacionBase + input.ocasionales_activos;
    const cupoNominalDisponible = Math.max(
      0,
      input.capacidad_nominal - ocupacionProyectada,
    );
    const inasistenciasDisponibles = Math.max(
      0,
      input.inasistencias_reportadas - input.ocasionales_activos,
    );
    const vacantesNetas = Math.min(
      cupoNominalDisponible,
      inasistenciasDisponibles,
    );

    return {
      id_viaje: input.id_viaje,
      id_ruta: input.id_ruta,
      estado_viaje: input.estado_viaje,
      hora_inicio_programada: new Date(input.hora_inicio_programada.getTime()),
      capacidad_nominal: input.capacidad_nominal,
      estudiantes_asignados: input.estudiantes_asignados,
      inasistencias_reportadas: input.inasistencias_reportadas,
      ocasionales_activos: input.ocasionales_activos,
      ocupacion_proyectada: ocupacionProyectada,
      inasistencias_disponibles: inasistenciasDisponibles,
      cupo_nominal_disponible: cupoNominalDisponible,
      vacantes_netas: vacantesNetas,
    };
  }

  evaluateLeadTime(
    horaInicioProgramada: Date,
    solicitadoEn: Date,
  ): LeadTimeEvaluation {
    if (
      !(horaInicioProgramada instanceof Date) ||
      Number.isNaN(horaInicioProgramada.getTime())
    ) {
      throw new RangeError(
        "hora_inicio_programada inválida para evaluar antelación temporal.",
      );
    }
    if (
      !(solicitadoEn instanceof Date) ||
      Number.isNaN(solicitadoEn.getTime())
    ) {
      throw new RangeError(
        "solicitado_en inválido para evaluar antelación temporal.",
      );
    }

    const diffMs = horaInicioProgramada.getTime() - solicitadoEn.getTime();
    const minutosAntelacion = Number((diffMs / 60000).toFixed(2));
    const horasAntelacion = Number((diffMs / 3600000).toFixed(4));
    const horaLimiteSolicitud = new Date(
      horaInicioProgramada.getTime() - MINIMUM_LEAD_TIME_MS,
    );

    return {
      cumple_antelacion: diffMs >= MINIMUM_LEAD_TIME_MS,
      minutos_antelacion: minutosAntelacion,
      horas_antelacion: horasAntelacion,
      minimo_horas_requerido: MINIMUM_LEAD_TIME_HOURS,
      hora_inicio_programada: new Date(horaInicioProgramada.getTime()),
      solicitado_en: new Date(solicitadoEn.getTime()),
      hora_limite_solicitud: horaLimiteSolicitud,
    };
  }

  /**
   * Evalúa conjuntamente TODAS las reglas RN-03 sin cortocircuito para informar
   * explícitamente cada incumplimiento (p. ej. falta de vacante Y antelación < 2h).
   */
  evaluateBookingEligibility(params: {
    balance: VacancyBalanceSnapshot;
    solicitadoEn: Date;
    hasUnallocatedAbsence: boolean;
  }): OccasionalEligibilityEvaluation {
    const antelacion = this.evaluateLeadTime(
      params.balance.hora_inicio_programada,
      params.solicitadoEn,
    );
    const motivos: OccasionalRejectionReason[] = [];

    if (!antelacion.cumple_antelacion) {
      motivos.push(OccasionalRejectionReason.ANTELACION_INSUFICIENTE);
    }

    if (
      !params.hasUnallocatedAbsence ||
      params.balance.inasistencias_disponibles <= 0
    ) {
      motivos.push(OccasionalRejectionReason.SIN_VACANTE_POR_INASISTENCIA);
    }

    if (
      params.balance.ocupacion_proyectada >= params.balance.capacidad_nominal
    ) {
      motivos.push(OccasionalRejectionReason.CAPACIDAD_NOMINAL_AGOTADA);
    }

    if (motivos.length === 0) {
      return {
        elegible: true,
        motivos_rechazo: [],
        antelacion,
        balance_vacantes: params.balance,
        mensaje: `Solicitud elegible: cumple antelación (>= ${MINIMUM_LEAD_TIME_HOURS}h) y cuenta con ${params.balance.vacantes_netas} vacante(s) neta(s) por inasistencia.`,
      };
    }

    const descripciones: string[] = [];
    if (motivos.includes(OccasionalRejectionReason.ANTELACION_INSUFICIENTE)) {
      descripciones.push(
        `antelación insuficiente (${antelacion.horas_antelacion}h < ${MINIMUM_LEAD_TIME_HOURS}h requeridas antes de ${antelacion.hora_inicio_programada.toISOString()})`,
      );
    }
    if (
      motivos.includes(OccasionalRejectionReason.SIN_VACANTE_POR_INASISTENCIA)
    ) {
      descripciones.push(
        `sin vacante disponible liberada por inasistencia previa (inasistencias disponibles: ${params.balance.inasistencias_disponibles})`,
      );
    }
    if (motivos.includes(OccasionalRejectionReason.CAPACIDAD_NOMINAL_AGOTADA)) {
      descripciones.push(
        `capacidad nominal agotada (${params.balance.ocupacion_proyectada}/${params.balance.capacidad_nominal}; sobrecupo prohibido)`,
      );
    }

    return {
      elegible: false,
      motivos_rechazo: motivos,
      antelacion,
      balance_vacantes: params.balance,
      mensaje: `Solicitud rechazada (RN-03) [${motivos.join(", ")}]: ${descripciones.join("; ")}.`,
    };
  }
}
