/**
 * Puerto de Dominio: Repositorio Genérico de Persistencia
 * Cumple con DIP (ADR-001): El dominio interactúa con abstracciones desacopladas de ORMs o drivers SQL.
 */
export interface IRepository<T, ID = string> {
  findById(id: ID): Promise<T | null>;
  findAll(filter?: Record<string, unknown>): Promise<T[]>;
  save(entity: T): Promise<T>;
  deleteById?(id: ID): Promise<boolean>;
}
