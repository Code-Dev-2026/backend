import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length } from 'class-validator';

export class VerifyMfaDto {
  @ApiProperty({ example: '123456', description: 'Código TOTP de 6 dígitos generado por Authenticator' })
  @IsString()
  @Length(6, 6, { message: 'El código TOTP debe contener exactamente 6 dígitos.' })
  @IsNotEmpty()
  code!: string;
}
