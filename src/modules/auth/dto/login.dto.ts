import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'coordinadora@sanbenito.edu.co', description: 'Correo electrónico institucional o de acudiente' })
  @IsEmail({}, { message: 'El correo debe tener un formato válido.' })
  @IsNotEmpty()
  email!: string;

  @ApiProperty({ example: 'ClaveRobusta2026*', description: 'Contraseña del usuario' })
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener mínimo 8 caracteres.' })
  @IsNotEmpty()
  password!: string;
}
