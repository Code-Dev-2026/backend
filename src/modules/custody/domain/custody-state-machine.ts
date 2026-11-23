import {
  CustodyTransitionEvaluationInput,
  CustodyTransitionOutcome,
  ICustodyTransition,
  createDefaultCustodyTransitions,
} from "./custody-transition.interface";
import {
  CustodyInvariantViolationError,
  FsmCustodyState,
  TripDirection,
  isFsmCustodyState,
  isTripDirection,
} from "./custody.types";

/**
 * Máquina de Estados Finitos (FSM) del ciclo de custodia física (Issue #7 / RN-01).
 *
 * Orquesta de forma homogénea las transiciones que implementan `ICustodyTransition`
 * (Principio LSP), garantizando unidireccionalidad estricta y reglas diferenciadas
 * para recorridos de Mañana (`MANANA`) y Tarde (`TARDE`).
 */
export class CustodyStateMachine {
  private readonly transitions: readonly ICustodyTransition[];

  constructor(
    transitions: readonly ICustodyTransition[] = createDefaultCustodyTransitions(),
  ) {
    this.transitions = Object.freeze([...transitions]);
  }

  getRegisteredTransitions(): readonly ICustodyTransition[] {
    return this.transitions;
  }

  resolveTransition(
    from: FsmCustodyState,
    to: FsmCustodyState,
    tripDirection: TripDirection,
  ): ICustodyTransition | null {
    if (
      !isFsmCustodyState(from) ||
      !isFsmCustodyState(to) ||
      !isTripDirection(tripDirection)
    ) {
      return null;
    }

    const input: CustodyTransitionEvaluationInput = {
      currentState: from,
      targetState: to,
      tripDirection,
    };

    return this.transitions.find((t) => t.canExecute(input)) ?? null;
  }

  canTransition(
    from: FsmCustodyState,
    to: FsmCustodyState,
    tripDirection: TripDirection,
  ): boolean {
    return this.resolveTransition(from, to, tripDirection) !== null;
  }

  getAllowedTargets(
    from: FsmCustodyState,
    tripDirection: TripDirection,
  ): FsmCustodyState[] {
    if (!isFsmCustodyState(from) || !isTripDirection(tripDirection)) {
      return [];
    }

    const targets = new Set<FsmCustodyState>();
    for (const transition of this.transitions) {
      if (
        transition.fromState === from &&
        transition.allowedDirections.includes(tripDirection)
      ) {
        targets.add(transition.toState);
      }
    }
    return [...targets];
  }

  transition(input: CustodyTransitionEvaluationInput): CustodyTransitionOutcome {
    if (!isTripDirection(input.tripDirection)) {
      throw new CustodyInvariantViolationError(
        input.currentState,
        input.targetState,
        String(input.tripDirection),
        [],
        `Tipo de recorrido inválido: '${String(input.tripDirection)}'. Debe ser MANANA o TARDE.`,
      );
    }

    if (!isFsmCustodyState(input.currentState)) {
      throw new CustodyInvariantViolationError(
        String(input.currentState),
        String(input.targetState),
        input.tripDirection,
        [],
        `Estado de origen desconocido en FSM de custodia: '${String(input.currentState)}'.`,
      );
    }

    if (!isFsmCustodyState(input.targetState)) {
      throw new CustodyInvariantViolationError(
        input.currentState,
        String(input.targetState),
        input.tripDirection,
        this.getAllowedTargets(input.currentState, input.tripDirection),
        `Estado de destino desconocido en FSM de custodia: '${String(input.targetState)}'.`,
      );
    }

    const matched = this.resolveTransition(
      input.currentState,
      input.targetState,
      input.tripDirection,
    );

    if (!matched) {
      throw new CustodyInvariantViolationError(
        input.currentState,
        input.targetState,
        input.tripDirection,
        this.getAllowedTargets(input.currentState, input.tripDirection),
      );
    }

    return matched.execute(input);
  }

  isTerminalState(state: FsmCustodyState, tripDirection: TripDirection): boolean {
    return this.getAllowedTargets(state, tripDirection).length === 0;
  }

  blocksTripClosure(state: FsmCustodyState): boolean {
    return state === FsmCustodyState.A_BORDO_VEHICULO;
  }
}
