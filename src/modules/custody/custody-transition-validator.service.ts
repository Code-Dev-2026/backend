import { Injectable } from "@nestjs/common";
import { CustodyStateMachine } from "./domain/custody-state-machine";
import { CustodyTransitionOutcome } from "./domain/custody-transition.interface";
import {
  CustodyCoordinates,
  FsmCustodyState,
  InvalidCustodyCoordinatesError,
  TripDirection,
} from "./domain/custody.types";

/**
 * Servicio de validación de transiciones permitidas según el tipo de recorrido
 * (Mañana / Tarde) y coordenadas WGS84 (Issue #7).
 */
@Injectable()
export class CustodyTransitionValidatorService {
  private readonly fsm: CustodyStateMachine;

  constructor() {
    this.fsm = new CustodyStateMachine();
  }

  getStateMachine(): CustodyStateMachine {
    return this.fsm;
  }

  isTransitionAllowed(
    from: FsmCustodyState,
    to: FsmCustodyState,
    tripDirection: TripDirection,
  ): boolean {
    return this.fsm.canTransition(from, to, tripDirection);
  }

  getAllowedNextStates(
    from: FsmCustodyState,
    tripDirection: TripDirection,
  ): FsmCustodyState[] {
    return this.fsm.getAllowedTargets(from, tripDirection);
  }

  validateTransition(params: {
    currentState: FsmCustodyState;
    targetState: FsmCustodyState;
    tripDirection: TripDirection;
    disparador_evento?: string;
    latitud?: number;
    longitud?: number;
  }): {
    outcome: CustodyTransitionOutcome;
    coordenadas: CustodyCoordinates | null;
  } {
    const coordenadas = this.validateCoordinates(
      params.latitud,
      params.longitud,
    );

    const outcome = this.fsm.transition({
      currentState: params.currentState,
      targetState: params.targetState,
      tripDirection: params.tripDirection,
      disparador_evento: params.disparador_evento,
    });

    return { outcome, coordenadas };
  }

  validateCoordinates(
    latitud?: number,
    longitud?: number,
  ): CustodyCoordinates | null {
    const hasLat = latitud !== undefined && latitud !== null;
    const hasLon = longitud !== undefined && longitud !== null;

    if (!hasLat && !hasLon) {
      return null;
    }

    if (hasLat !== hasLon) {
      throw new InvalidCustodyCoordinatesError(
        "Latitud y longitud deben enviarse juntas o omitirse ambas.",
      );
    }

    if (
      !Number.isFinite(latitud) ||
      !Number.isFinite(longitud) ||
      latitud! < -90 ||
      latitud! > 90 ||
      longitud! < -180 ||
      longitud! > 180
    ) {
      throw new InvalidCustodyCoordinatesError(
        `Coordenadas fuera de rango WGS84: latitud=${latitud}, longitud=${longitud}.`,
      );
    }

    return { latitud: latitud!, longitud: longitud! };
  }
}
