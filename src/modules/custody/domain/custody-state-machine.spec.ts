import { CustodyStateMachine } from "./custody-state-machine";
import {
  ArriveAtSchoolTransition,
  BaseCustodyTransition,
  BoardVehicleTransition,
  CompleteReturnAtSchoolTransition,
  DeliverToGuardianTransition,
  FallbackReturnToSchoolTransition,
  ICustodyTransition,
  StartWaitingForBoardingTransition,
  createDefaultCustodyTransitions,
} from "./custody-transition.interface";
import {
  ALL_FSM_CUSTODY_STATES,
  ALL_TRIP_DIRECTIONS,
  CustodyInvariantViolationError,
  FsmCustodyState,
  TripDirection,
} from "./custody.types";

/**
 * Matriz oficial de transiciones válidas (RN-01 / Issue #7):
 * - MANANA:
 *   1. NO_INICIADO -> EN_ESPERA_ABORDAJE
 *   2. EN_ESPERA_ABORDAJE -> A_BORDO_VEHICULO
 *   3. A_BORDO_VEHICULO -> EN_COLEGIO
 * - TARDE:
 *   1. NO_INICIADO -> EN_ESPERA_ABORDAJE
 *   2. EN_ESPERA_ABORDAJE -> A_BORDO_VEHICULO
 *   3. A_BORDO_VEHICULO -> ENTREGADO_ACUDIENTE
 *   4. A_BORDO_VEHICULO -> RETORNO_SEDE_POR_FALLA_ENTREGA
 *   5. RETORNO_SEDE_POR_FALLA_ENTREGA -> EN_COLEGIO
 */
const EXPECTED_VALID_TRANSITIONS: Readonly<
  Record<TripDirection, ReadonlySet<string>>
> = {
  [TripDirection.MANANA]: new Set([
    `${FsmCustodyState.NO_INICIADO}->${FsmCustodyState.EN_ESPERA_ABORDAJE}`,
    `${FsmCustodyState.EN_ESPERA_ABORDAJE}->${FsmCustodyState.A_BORDO_VEHICULO}`,
    `${FsmCustodyState.A_BORDO_VEHICULO}->${FsmCustodyState.EN_COLEGIO}`,
  ]),
  [TripDirection.TARDE]: new Set([
    `${FsmCustodyState.NO_INICIADO}->${FsmCustodyState.EN_ESPERA_ABORDAJE}`,
    `${FsmCustodyState.EN_ESPERA_ABORDAJE}->${FsmCustodyState.A_BORDO_VEHICULO}`,
    `${FsmCustodyState.A_BORDO_VEHICULO}->${FsmCustodyState.ENTREGADO_ACUDIENTE}`,
    `${FsmCustodyState.A_BORDO_VEHICULO}->${FsmCustodyState.RETORNO_SEDE_POR_FALLA_ENTREGA}`,
    `${FsmCustodyState.RETORNO_SEDE_POR_FALLA_ENTREGA}->${FsmCustodyState.EN_COLEGIO}`,
  ]),
};

describe("CustodyStateMachine — Matriz exhaustiva FSM y Principio LSP (Issue #7)", () => {
  let fsm: CustodyStateMachine;

  beforeEach(() => {
    fsm = new CustodyStateMachine();
  });

  describe("Criterio de Aceptación #7", () => {
    it.each(ALL_TRIP_DIRECTIONS)(
      "Dado NO_INICIADO, rechaza salto directo a ENTREGADO_ACUDIENTE en recorrido %s arrojando CustodyInvariantViolationError",
      (direction) => {
        expect(
          fsm.canTransition(
            FsmCustodyState.NO_INICIADO,
            FsmCustodyState.ENTREGADO_ACUDIENTE,
            direction,
          ),
        ).toBe(false);

        let caught: unknown;
        try {
          fsm.transition({
            currentState: FsmCustodyState.NO_INICIADO,
            targetState: FsmCustodyState.ENTREGADO_ACUDIENTE,
            tripDirection: direction,
          });
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(CustodyInvariantViolationError);
        const domainError = caught as CustodyInvariantViolationError;
        expect(domainError.code).toBe("CUSTODY_FSM_INVARIANT_VIOLATION");
        expect(domainError.fromState).toBe(FsmCustodyState.NO_INICIADO);
        expect(domainError.toState).toBe(FsmCustodyState.ENTREGADO_ACUDIENTE);
        expect(domainError.tripDirection).toBe(direction);
        expect(domainError.allowedTargets).toEqual([
          FsmCustodyState.EN_ESPERA_ABORDAJE,
        ]);
      },
    );
  });

  describe("Cobertura 100% exhaustiva de la matriz de transición (6 x 6 x 2 = 72 combinaciones)", () => {
    const allMatrixCases: Array<{
      direction: TripDirection;
      from: FsmCustodyState;
      to: FsmCustodyState;
      expectedValid: boolean;
    }> = [];

    for (const direction of ALL_TRIP_DIRECTIONS) {
      for (const from of ALL_FSM_CUSTODY_STATES) {
        for (const to of ALL_FSM_CUSTODY_STATES) {
          const key = `${from}->${to}`;
          allMatrixCases.push({
            direction,
            from,
            to,
            expectedValid: EXPECTED_VALID_TRANSITIONS[direction].has(key),
          });
        }
      }
    }

    it("evalúa exactamente 72 combinaciones (8 válidas y 64 inválidas)", () => {
      expect(allMatrixCases).toHaveLength(72);
      expect(allMatrixCases.filter((c) => c.expectedValid)).toHaveLength(8);
      expect(allMatrixCases.filter((c) => !c.expectedValid)).toHaveLength(64);
    });

    it.each(allMatrixCases)(
      "[$direction] $from -> $to debe ser válida=$expectedValid",
      ({ direction, from, to, expectedValid }) => {
        expect(fsm.canTransition(from, to, direction)).toBe(expectedValid);

        if (expectedValid) {
          const outcome = fsm.transition({
            currentState: from,
            targetState: to,
            tripDirection: direction,
          });
          expect(outcome.fromState).toBe(from);
          expect(outcome.toState).toBe(to);
          expect(outcome.tripDirection).toBe(direction);
          expect(outcome.disparador_evento.length).toBeGreaterThan(0);
        } else {
          expect(() =>
            fsm.transition({
              currentState: from,
              targetState: to,
              tripDirection: direction,
            }),
          ).toThrow(CustodyInvariantViolationError);
        }
      },
    );
  });

  describe("Verificación del Principio de Sustitución de Liskov (LSP) sobre ICustodyTransition", () => {
    const allConcreteTransitions: ICustodyTransition[] = [
      new StartWaitingForBoardingTransition(),
      new BoardVehicleTransition(),
      new ArriveAtSchoolTransition(),
      new DeliverToGuardianTransition(),
      new FallbackReturnToSchoolTransition(),
      new CompleteReturnAtSchoolTransition(),
    ];

    it.each(allConcreteTransitions)(
      "cada subtipo concreto ($constructor.name) cumple de forma homogénea el contrato ICustodyTransition",
      (transition) => {
        for (const direction of ALL_TRIP_DIRECTIONS) {
          for (const from of ALL_FSM_CUSTODY_STATES) {
            for (const to of ALL_FSM_CUSTODY_STATES) {
              const input = {
                currentState: from,
                targetState: to,
                tripDirection: direction,
              };
              const executable = transition.canExecute(input);

              if (executable) {
                const outcome = transition.execute(input);
                expect(outcome.fromState).toBe(transition.fromState);
                expect(outcome.toState).toBe(transition.toState);
                expect(outcome.tripDirection).toBe(direction);
                expect(outcome.disparador_evento).toBe(
                  transition.defaultTriggerEvent,
                );
                expect(outcome.setsHoraAbordaje).toBe(
                  transition.setsHoraAbordaje,
                );
                expect(outcome.setsHoraDesembarque).toBe(
                  transition.setsHoraDesembarque,
                );
              } else {
                expect(() => transition.execute(input)).toThrow(
                  CustodyInvariantViolationError,
                );
              }
            }
          }
        }
      },
    );

    it("el orquestador CustodyStateMachine acepta cualquier colección polimórfica de ICustodyTransition", () => {
      class CustomBoardTransition extends BaseCustodyTransition {
        readonly fromState = FsmCustodyState.EN_ESPERA_ABORDAJE;
        readonly toState = FsmCustodyState.A_BORDO_VEHICULO;
        readonly allowedDirections = [TripDirection.MANANA] as const;
        readonly defaultTriggerEvent = "ABORDAJE_PERSONALIZADO";
        override readonly setsHoraAbordaje = true;
      }

      const customFsm = new CustodyStateMachine([new CustomBoardTransition()]);
      const outcome = customFsm.transition({
        currentState: FsmCustodyState.EN_ESPERA_ABORDAJE,
        targetState: FsmCustodyState.A_BORDO_VEHICULO,
        tripDirection: TripDirection.MANANA,
      });

      expect(outcome.disparador_evento).toBe("ABORDAJE_PERSONALIZADO");
      expect(outcome.setsHoraAbordaje).toBe(true);
      expect(customFsm.getRegisteredTransitions()).toHaveLength(1);
    });

    it("createDefaultCustodyTransitions registra las 6 aristas oficiales inmutables", () => {
      const defaults = createDefaultCustodyTransitions();
      expect(defaults).toHaveLength(6);
      expect(Object.isFrozen(defaults)).toBe(true);
    });
  });

  describe("Estados terminales, bloqueos de cierre y casos borde", () => {
    it("identifica correctamente estados terminales por recorrido", () => {
      expect(
        fsm.isTerminalState(FsmCustodyState.EN_COLEGIO, TripDirection.MANANA),
      ).toBe(true);
      expect(
        fsm.isTerminalState(
          FsmCustodyState.ENTREGADO_ACUDIENTE,
          TripDirection.TARDE,
        ),
      ).toBe(true);
      expect(
        fsm.isTerminalState(FsmCustodyState.EN_COLEGIO, TripDirection.TARDE),
      ).toBe(true);
      expect(
        fsm.isTerminalState(
          FsmCustodyState.RETORNO_SEDE_POR_FALLA_ENTREGA,
          TripDirection.TARDE,
        ),
      ).toBe(false);
      expect(
        fsm.isTerminalState(
          FsmCustodyState.A_BORDO_VEHICULO,
          TripDirection.MANANA,
        ),
      ).toBe(false);
    });

    it("identifica que solo A_BORDO_VEHICULO bloquea el cierre del viaje (FINALIZADO)", () => {
      for (const state of ALL_FSM_CUSTODY_STATES) {
        expect(fsm.blocksTripClosure(state)).toBe(
          state === FsmCustodyState.A_BORDO_VEHICULO,
        );
      }
    });

    it("rechaza estados desconocidos o tipo de recorrido inválido con CustodyInvariantViolationError", () => {
      expect(
        fsm.canTransition(
          "ESTADO_INVALIDO" as FsmCustodyState,
          FsmCustodyState.EN_ESPERA_ABORDAJE,
          TripDirection.MANANA,
        ),
      ).toBe(false);

      expect(() =>
        fsm.transition({
          currentState: "ESTADO_INVALIDO" as FsmCustodyState,
          targetState: FsmCustodyState.EN_ESPERA_ABORDAJE,
          tripDirection: TripDirection.MANANA,
        }),
      ).toThrow(CustodyInvariantViolationError);

      expect(() =>
        fsm.transition({
          currentState: FsmCustodyState.NO_INICIADO,
          targetState: "ESTADO_FALSO" as FsmCustodyState,
          tripDirection: TripDirection.MANANA,
        }),
      ).toThrow(CustodyInvariantViolationError);

      expect(() =>
        fsm.transition({
          currentState: FsmCustodyState.NO_INICIADO,
          targetState: FsmCustodyState.EN_ESPERA_ABORDAJE,
          tripDirection: "NOCHE" as TripDirection,
        }),
      ).toThrow(CustodyInvariantViolationError);

      expect(
        fsm.getAllowedTargets(
          "DESCONOCIDO" as FsmCustodyState,
          TripDirection.MANANA,
        ),
      ).toEqual([]);
    });
  });
});
