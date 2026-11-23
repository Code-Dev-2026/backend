import { uuidv7 } from "@common/utils/uuidv7";
import { UserRecord } from "./auth.models";

/**
 * Entidad de dominio User (identidad de conductores, monitoras,
 * directivos y acudientes).
 * Se persiste en las tablas `usuario` + `usuario_rol` + `mfa_secret` (V002);
 * `toRecord()` hace esa traducción.
 */
export class User {
  constructor(
    /** UUIDv7 (ordenable por tiempo). */
    public readonly id: string,
    public readonly email: string,
    /** Hash Argon2id; la contraseña en claro nunca se guarda. */
    public readonly password_hash: string,
    public readonly rol: string,
    /** Secreto TOTP cifrado (opcional; el OTP por correo no lo necesita). */
    public readonly mfa_secret: string | null = null,
    public readonly mfa_enabled: boolean = true,
    public readonly is_active: boolean = true,
  ) {}

  static create(props: {
    email: string;
    password_hash: string;
    rol: string;
  }): User {
    return new User(
      uuidv7(),
      props.email.trim().toLowerCase(),
      props.password_hash,
      props.rol,
    );
  }

  toRecord(): UserRecord {
    return {
      id_usuario: this.id,
      email: this.email,
      password_hash: this.password_hash,
      estado: this.is_active ? "ACTIVO" : "INACTIVO",
      mfa_habilitado: this.mfa_enabled,
      roles: [this.rol],
    };
  }

  /** Vista sin datos sensibles (sin hash ni secreto MFA). */
  toPublic(): PublicUserView {
    return {
      id: this.id,
      email: this.email,
      rol: this.rol,
      mfa_enabled: this.mfa_enabled,
      is_active: this.is_active,
    };
  }
}

export interface PublicUserView {
  id: string;
  email: string;
  rol: string;
  mfa_enabled: boolean;
  is_active: boolean;
}
