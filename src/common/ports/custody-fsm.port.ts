import { CustodyStateEnum } from "../enums/custody-state.enum";

export type CustodyTripDirection = "MANANA" | "TARDE";

export const CUSTODY_FSM_PORT = Symbol("CUSTODY_FSM_PORT");

export interface CustodyTransitionContext {
  id_estudiante: string;
  id_viaje: string;
  estado_origen: CustodyStateEnum;
  estado_destino: CustodyStateEnum;
  id_monitora: string;
  tipo_recorrido?: CustodyTripDirection;
  disparador_evento?: string;
  id_receptor?: string;
  latitud?: number;
  longitud?: number;
}

/**
 * Puerto de Dominio: Máquina de Estados FSM de Custodia
 */
export interface ICustodyFsmPort {
  transition(
    context: CustodyTransitionContext,
  ): Promise<{ success: boolean; newState: CustodyStateEnum }>;
  canTransition(
    from: CustodyStateEnum,
    to: CustodyStateEnum,
    tipo_recorrido?: CustodyTripDirection,
  ): boolean;
}
