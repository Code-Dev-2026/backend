import {
  CustodyInvariantViolationError,
  FsmCustodyState,
  TripDirection,
} from "./custody.types";

export interface CustodyTransitionEvaluationInput {
  currentState: FsmCustodyState;
  targetState: FsmCustodyState;
  tripDirection: TripDirection;
  disparador_evento?: string;
}

export interface CustodyTransitionOutcome {
  fromState: FsmCustodyState;
  toState: FsmCustodyState;
  tripDirection: TripDirection;
  disparador_evento: string;
  setsHoraAbordaje: boolean;
  setsHoraDesembarque: boolean;
}

/**
 * Contrato de transición de estado de custodia (Principio LSP - Issue #7).
 *
 * Todas las implementaciones concretas honran exactamente las mismas
 * precondiciones y postcondiciones:
 * - `canExecute(input)` es puro, determinista y retorna `true` si y solo si
 *   `currentState === fromState`, `targetState === toState` y `tripDirection`
 *   pertenece a `allowedDirections`.
 * - `execute(input)` retorna un `CustodyTransitionOutcome` válido cuando
 *   `canExecute(input) === true`, o lanza `CustodyInvariantViolationError` en
 *   caso contrario, permitiendo sustitución homogénea en el orquestador.
 */
export interface ICustodyTransition {
  readonly fromState: FsmCustodyState;
  readonly toState: FsmCustodyState;
  readonly allowedDirections: readonly TripDirection[];
  readonly defaultTriggerEvent: string;
  readonly setsHoraAbordaje: boolean;
  readonly setsHoraDesembarque: boolean;

  canExecute(input: CustodyTransitionEvaluationInput): boolean;
  execute(input: CustodyTransitionEvaluationInput): CustodyTransitionOutcome;
}

/**
 * Implementación base coherente con el contrato LSP de `ICustodyTransition`.
 * Las subclases solo declaran su arista dirigida y metadatos de transición sin
 * fortalecer precondiciones ni debilitar postcondiciones.
 */
export abstract class BaseCustodyTransition implements ICustodyTransition {
  abstract readonly fromState: FsmCustodyState;
  abstract readonly toState: FsmCustodyState;
  abstract readonly allowedDirections: readonly TripDirection[];
  abstract readonly defaultTriggerEvent: string;
  readonly setsHoraAbordaje: boolean = false;
  readonly setsHoraDesembarque: boolean = false;

  canExecute(input: CustodyTransitionEvaluationInput): boolean {
    return (
      input.currentState === this.fromState &&
      input.targetState === this.toState &&
      this.allowedDirections.includes(input.tripDirection)
    );
  }

  execute(input: CustodyTransitionEvaluationInput): CustodyTransitionOutcome {
    if (!this.canExecute(input)) {
      throw new CustodyInvariantViolationError(
        input.currentState,
        input.targetState,
        input.tripDirection,
        this.allowedDirections.includes(input.tripDirection) &&
          input.currentState === this.fromState
          ? [this.toState]
          : [],
      );
    }

    const trigger = input.disparador_evento?.trim() || this.defaultTriggerEvent;

    return {
      fromState: this.fromState,
      toState: this.toState,
      tripDirection: input.tripDirection,
      disparador_evento: trigger,
      setsHoraAbordaje: this.setsHoraAbordaje,
      setsHoraDesembarque: this.setsHoraDesembarque,
    };
  }
}

/** NO_INICIADO -> EN_ESPERA_ABORDAJE (Mañana y Tarde) */
export class StartWaitingForBoardingTransition extends BaseCustodyTransition {
  readonly fromState = FsmCustodyState.NO_INICIADO;
  readonly toState = FsmCustodyState.EN_ESPERA_ABORDAJE;
  readonly allowedDirections = [
    TripDirection.MANANA,
    TripDirection.TARDE,
  ] as const;
  readonly defaultTriggerEvent = "INICIO_ESPERA_ABORDAJE";
}

/** EN_ESPERA_ABORDAJE -> A_BORDO_VEHICULO (Mañana y Tarde) */
export class BoardVehicleTransition extends BaseCustodyTransition {
  readonly fromState = FsmCustodyState.EN_ESPERA_ABORDAJE;
  readonly toState = FsmCustodyState.A_BORDO_VEHICULO;
  readonly allowedDirections = [
    TripDirection.MANANA,
    TripDirection.TARDE,
  ] as const;
  readonly defaultTriggerEvent = "ABORDAJE_VEHICULO";
  override readonly setsHoraAbordaje = true;
}

/** A_BORDO_VEHICULO -> EN_COLEGIO (Solo recorrido Mañana) */
export class ArriveAtSchoolTransition extends BaseCustodyTransition {
  readonly fromState = FsmCustodyState.A_BORDO_VEHICULO;
  readonly toState = FsmCustodyState.EN_COLEGIO;
  readonly allowedDirections = [TripDirection.MANANA] as const;
  readonly defaultTriggerEvent = "LLEGADA_COLEGIO";
  override readonly setsHoraDesembarque = true;
}

/** A_BORDO_VEHICULO -> ENTREGADO_ACUDIENTE (Solo recorrido Tarde) */
export class DeliverToGuardianTransition extends BaseCustodyTransition {
  readonly fromState = FsmCustodyState.A_BORDO_VEHICULO;
  readonly toState = FsmCustodyState.ENTREGADO_ACUDIENTE;
  readonly allowedDirections = [TripDirection.TARDE] as const;
  readonly defaultTriggerEvent = "ENTREGA_ACUDIENTE";
  override readonly setsHoraDesembarque = true;
}

/** A_BORDO_VEHICULO -> RETORNO_SEDE_POR_FALLA_ENTREGA (Solo recorrido Tarde) */
export class FallbackReturnToSchoolTransition extends BaseCustodyTransition {
  readonly fromState = FsmCustodyState.A_BORDO_VEHICULO;
  readonly toState = FsmCustodyState.RETORNO_SEDE_POR_FALLA_ENTREGA;
  readonly allowedDirections = [TripDirection.TARDE] as const;
  readonly defaultTriggerEvent = "FALLA_ENTREGA_RETORNO_SEDE";
}

/** RETORNO_SEDE_POR_FALLA_ENTREGA -> EN_COLEGIO (Solo recorrido Tarde) */
export class CompleteReturnAtSchoolTransition extends BaseCustodyTransition {
  readonly fromState = FsmCustodyState.RETORNO_SEDE_POR_FALLA_ENTREGA;
  readonly toState = FsmCustodyState.EN_COLEGIO;
  readonly allowedDirections = [TripDirection.TARDE] as const;
  readonly defaultTriggerEvent = "RECEPCION_SEDE_POR_RETORNO";
  override readonly setsHoraDesembarque = true;
}

export function createDefaultCustodyTransitions(): readonly ICustodyTransition[] {
  return Object.freeze([
    new StartWaitingForBoardingTransition(),
    new BoardVehicleTransition(),
    new ArriveAtSchoolTransition(),
    new DeliverToGuardianTransition(),
    new FallbackReturnToSchoolTransition(),
    new CompleteReturnAtSchoolTransition(),
  ]);
}
