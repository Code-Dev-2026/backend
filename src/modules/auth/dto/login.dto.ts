import { IsEmail, IsNotEmpty, IsString, MinLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class LoginDto {
  @ApiProperty({
    example: "coordinacion@sanbenito.edu.co",
    description: "Correo electrónico institucional",
  })
  @IsEmail({}, { message: "El correo debe tener un formato válido." })
  @IsNotEmpty({ message: "El correo electrónico es obligatorio." })
  email!: string;

  @ApiProperty({
    example: "ContrasenaSegura#2026",
    description: "Contraseña del usuario",
  })
  @IsString({ message: "La contraseña debe ser una cadena de texto." })
  @MinLength(8, { message: "La contraseña debe tener mínimo 8 caracteres." })
  password!: string;
}
