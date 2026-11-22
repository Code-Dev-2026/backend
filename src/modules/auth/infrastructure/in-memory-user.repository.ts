import { Injectable } from "@nestjs/common";
import { EstadoUsuario, UserRecord } from "../domain/auth.models";
import { IUserRepository } from "../domain/user.repository";

/**
 * Adaptador TEMPORAL en memoria de IUserRepository.
 * Arranca VACÍO a propósito (sin usuarios ni contraseñas por defecto).
 * Se reemplaza por una implementación PostgreSQL (tablas usuario, rol,
 * usuario_rol) cambiando un solo provider (USER_REPOSITORY) en AuthModule.
 */
@Injectable()
export class InMemoryUserRepository implements IUserRepository {
  private readonly users = new Map<string, UserRecord>();
  readonly ultimoIngreso = new Map<string, Date>();

  add(user: UserRecord): void {
    this.users.set(user.id_usuario, { ...user, roles: [...user.roles] });
  }

  setEstado(idUsuario: string, estado: EstadoUsuario): void {
    const user = this.users.get(idUsuario);
    if (user) {
      user.estado = estado;
    }
  }

  async create(user: UserRecord): Promise<void> {
    this.add(user);
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const wanted = email.trim().toLowerCase();
    for (const user of this.users.values()) {
      if (user.email.toLowerCase() === wanted) {
        return { ...user, roles: [...user.roles] };
      }
    }
    return null;
  }

  async findById(idUsuario: string): Promise<UserRecord | null> {
    const user = this.users.get(idUsuario);
    return user ? { ...user, roles: [...user.roles] } : null;
  }

  async registrarUltimoIngreso(idUsuario: string, fecha: Date): Promise<void> {
    this.ultimoIngreso.set(idUsuario, fecha);
  }
}
