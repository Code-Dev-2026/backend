import { ConflictException, Inject, Injectable } from "@nestjs/common";
import {
  IPasswordHasher,
  PASSWORD_HASHER,
} from "./domain/password-hasher.interface";
import { PublicUserView, User } from "./domain/user.entity";
import { IUserRepository, USER_REPOSITORY } from "./domain/user.repository";
import { CreateUserDto } from "./dto/create-user.dto";

/**
 * Servicio de usuarios: alta de cuentas con contraseña hasheada en
 * Argon2id (m=64MB, t=3, p=4) a través del puerto IPasswordHasher.
 */
@Injectable()
export class UsersService {
  constructor(
    @Inject(USER_REPOSITORY) private readonly userRepository: IUserRepository,
    @Inject(PASSWORD_HASHER) private readonly passwordHasher: IPasswordHasher,
  ) {}

  async create(dto: CreateUserDto): Promise<PublicUserView> {
    const email = dto.email.trim().toLowerCase();
    if (await this.userRepository.findByEmail(email)) {
      throw new ConflictException("Ya existe un usuario con ese correo.");
    }

    const user = User.create({
      email,
      password_hash: await this.passwordHasher.hash(dto.password),
      rol: dto.rol,
    });
    await this.userRepository.create(user.toRecord());

    return user.toPublic();
  }
}
