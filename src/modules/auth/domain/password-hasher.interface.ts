/**
 * Puerto de Dominio: Hashing de contraseñas (DIP).
 * Los casos de uso dependen de esta abstracción, no de Argon2 ni Bcrypt.
 */
export interface IPasswordHasher {
  /** Genera el hash de una contraseña en texto plano. */
  hash(plain: string): Promise<string>;

  /** Compara una contraseña en texto plano contra un hash almacenado. */
  verify(plain: string, hash: string): Promise<boolean>;
}

/** Token de inyección de dependencias para IPasswordHasher. */
export const PASSWORD_HASHER = Symbol("IPasswordHasher");
