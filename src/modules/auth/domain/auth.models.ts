/**
 * Modelos de dominio de identidad (espejo de las tablas V002).
 * Sin dependencia de TypeORM ni de ningún driver SQL (DIP).
 */

export type EstadoUsuario = "ACTIVO" | "INACTIVO" | "BLOQUEADO";

/** Tabla `usuario` + roles asignados vía `usuario_rol`. */
export interface UserRecord {
  id_usuario: string;
  email: string;
  password_hash: string;
  estado: EstadoUsuario;
  mfa_habilitado: boolean;
  roles: string[];
}

/** Tabla `refresh_token`. */
export interface RefreshTokenRecord {
  id_token: string;
  id_usuario: string;
  family_id: string;
  token_hash: string; // SHA-256 del refresh token
  revocado: boolean;
  expira_en: Date;
}

/** Desafío OTP enviado por correo (segundo paso del login). */
export interface EmailOtpRecord {
  id_desafio: string; // UUIDv7, viaja en el token provisional (claim `cid`)
  id_usuario: string;
  code_hash: string; // SHA-256(id_desafio:código); el código nunca se guarda
  expira_en: Date;
  intentos: number;
  consumido: boolean;
}

/** Tabla `mfa_secret`. */
export interface MfaSecretRecord {
  id_usuario: string;
  secret_cifrado: string; // AES-256-GCM
  backup_codes_hashes: string[];
  confirmado: boolean;
}
