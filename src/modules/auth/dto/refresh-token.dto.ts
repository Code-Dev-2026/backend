import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({ description: 'Refresh Token emitido en la sesión' })
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}
