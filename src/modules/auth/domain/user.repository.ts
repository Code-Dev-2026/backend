import { UserRecord } from "./auth.models";

/** Puerto de persistencia de usuarios (DIP). */
export interface IUserRepository {
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(idUsuario: string): Promise<UserRecord | null>;
  create(user: UserRecord): Promise<void>;
  registrarUltimoIngreso(idUsuario: string, fecha: Date): Promise<void>;
}

export const USER_REPOSITORY = Symbol("IUserRepository");
