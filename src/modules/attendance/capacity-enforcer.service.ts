import { Injectable } from "@nestjs/common";
import { BoardingResultCode } from "./domain/attendance.types";

export interface CapacityEvaluation {
  permitido: boolean;
  codigo:
    | BoardingResultCode.ABORDAJE_EXITOSO
    | BoardingResultCode.DENEGADO_SOBRECUPO;
  total_actual: number;
  total_proyectado: number;
  capacidad_nominal: number;
  cupos_restantes: number;
  porcentaje_ocupacion: number;
  mensaje: string;
}

/**
 * Servicio SRP responsable exclusivamente de verificar y hacer cumplir las reglas
 * físicas de cupo nominal del vehículo (Issue #8: RN-02 Prohibición Estricta de Sobrecupo).
 */
@Injectable()
export class CapacityEnforcer {
  assertValidCapacityBounds(
    totalABordo: number,
    capacidadNominal: number,
  ): void {
    if (!Number.isInteger(capacidadNominal) || capacidadNominal <= 0) {
      throw new RangeError(
        `capacidad_nominal inválida (${capacidadNominal}): debe ser un entero positivo.`,
      );
    }

    if (!Number.isInteger(totalABordo) || totalABordo < 0) {
      throw new RangeError(
        `total_a_bordo inválido (${totalABordo}): debe ser un entero mayor o igual a 0.`,
      );
    }
  }

  canBoard(totalABordo: number, capacidadNominal: number): boolean {
    this.assertValidCapacityBounds(totalABordo, capacidadNominal);
    return totalABordo < capacidadNominal;
  }

  evaluateBoardingCapacity(
    totalABordo: number,
    capacidadNominal: number,
  ): CapacityEvaluation {
    this.assertValidCapacityBounds(totalABordo, capacidadNominal);

    if (totalABordo >= capacidadNominal) {
      return {
        permitido: false,
        codigo: BoardingResultCode.DENEGADO_SOBRECUPO,
        total_actual: totalABordo,
        total_proyectado: totalABordo,
        capacidad_nominal: capacidadNominal,
        cupos_restantes: 0,
        porcentaje_ocupacion: 100,
        mensaje: `Abordaje denegado: el vehículo alcanzó su capacidad máxima homologada (${totalABordo}/${capacidadNominal} pasajeros).`,
      };
    }

    const totalProyectado = totalABordo + 1;
    const cuposRestantes = Math.max(0, capacidadNominal - totalProyectado);
    const porcentaje = Number(
      ((totalProyectado / capacidadNominal) * 100).toFixed(2),
    );

    return {
      permitido: true,
      codigo: BoardingResultCode.ABORDAJE_EXITOSO,
      total_actual: totalABordo,
      total_proyectado: totalProyectado,
      capacidad_nominal: capacidadNominal,
      cupos_restantes: cuposRestantes,
      porcentaje_ocupacion: porcentaje,
      mensaje: `Abordaje autorizado (${totalProyectado}/${capacidadNominal} pasajeros a bordo).`,
    };
  }
}
