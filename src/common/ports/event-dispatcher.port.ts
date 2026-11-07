/**
 * Puerto de Dominio: Despachador de Eventos de Dominio Desacoplados
 */
export interface IEventDispatcherPort {
  publish<T = unknown>(eventName: string, payload: T): Promise<void>;
  subscribe?<T = unknown>(
    eventName: string,
    handler: (payload: T) => Promise<void>,
  ): void;
}
