import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class RefreshTokenDto {
  @ApiProperty({ description: "Refresh token vigente emitido en el login." })
  @IsString({ message: "El refresh token debe ser una cadena de texto." })
  @IsNotEmpty({ message: "El refresh token es obligatorio." })
  @MaxLength(512, { message: "El refresh token es demasiado largo." })
  refreshToken!: string;
}
