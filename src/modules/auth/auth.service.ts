import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { UserRecord } from "./domain/auth.models";
import {
  IPasswordHasher,
  PASSWORD_HASHER,
} from "./domain/password-hasher.interface";
import { IUserRepository, USER_REPOSITORY } from "./domain/user.repository";

const MENSAJE_CREDENCIALES = "Credenciales inválidas.";

/**
 * Validación de credenciales (SRP: no emite tokens ni valida OTP).
 * Todos los fallos devuelven el mismo mensaje para no revelar si el correo
 * existe, y se hace un hash de relleno cuando el usuario no existe para que
 * el tiempo de respuesta no lo delate (ASVS V2.2).
 */
@Injectable()
export class AuthService {
  private dummyHash: Promise<string> | null = null;

  constructor(
    @Inject(USER_REPOSITORY) private readonly userRepository: IUserRepository,
    @Inject(PASSWORD_HASHER) private readonly passwordHasher: IPasswordHasher,
  ) {}

  async validateCredentials(
    email: string,
    password: string,
  ): Promise<UserRecord> {
    if (!email || !password) {
      throw new UnauthorizedException(MENSAJE_CREDENCIALES);
    }

    const user = await this.userRepository.findByEmail(email);

    if (!user) {
      await this.passwordHasher.verify(password, await this.getDummyHash());
      throw new UnauthorizedException(MENSAJE_CREDENCIALES);
    }

    const passwordOk = await this.passwordHasher.verify(
      password,
      user.password_hash,
    );
    if (!passwordOk || user.estado !== "ACTIVO") {
      throw new UnauthorizedException(MENSAJE_CREDENCIALES);
    }

    return user;
  }

  private getDummyHash(): Promise<string> {
    if (!this.dummyHash) {
      this.dummyHash = this.passwordHasher.hash("relleno-anti-enumeracion");
    }
    return this.dummyHash;
  }
}
