import { ApiProperty } from "@nestjs/swagger";
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";
import { RoleEnum } from "@common/enums/role.enum";

/** Roles de base de datos (V002) que se pueden asignar a un usuario. */
export const ASSIGNABLE_ROLES: readonly string[] = [
  RoleEnum.COORDINADORA_CONVIVENCIA,
  RoleEnum.RECTORIA,
  RoleEnum.GERENCIA_TRANSPORTE,
  RoleEnum.JEFE_OPERACIONES,
  RoleEnum.ADMINISTRADOR_CARTERA,
  RoleEnum.MONITORA,
  RoleEnum.CONDUCTOR,
  RoleEnum.ACUDIENTE,
];

export class CreateUserDto {
  @ApiProperty({ example: "conductor@transportes.co" })
  @IsEmail({}, { message: "El correo debe tener un formato válido." })
  @IsNotEmpty({ message: "El correo electrónico es obligatorio." })
  @MaxLength(120, { message: "El correo no puede superar 120 caracteres." })
  email!: string;

  @ApiProperty({
    example: "ContrasenaSegura#2026",
    description: "Mínimo 12 caracteres, con mayúscula, minúscula y número.",
  })
  @IsString({ message: "La contraseña debe ser una cadena de texto." })
  @MinLength(12, { message: "La contraseña debe tener mínimo 12 caracteres." })
  @MaxLength(128, { message: "La contraseña no puede superar 128 caracteres." })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/, {
    message: "La contraseña debe incluir mayúscula, minúscula y número.",
  })
  password!: string;

  @ApiProperty({ enum: ASSIGNABLE_ROLES, example: RoleEnum.CONDUCTOR })
  @IsIn(ASSIGNABLE_ROLES, { message: "El rol indicado no es válido." })
  rol!: string;
}
