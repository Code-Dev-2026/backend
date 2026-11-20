import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, Matches, MaxLength } from "class-validator";

export class MfaVerifyDto {
  @ApiProperty({
    description: "Token provisional recibido en el login (mfaToken).",
  })
  @IsString({ message: "El token provisional debe ser una cadena de texto." })
  @IsNotEmpty({ message: "El token provisional es obligatorio." })
  @MaxLength(2048, { message: "El token provisional es demasiado largo." })
  mfaToken!: string;

  @ApiProperty({
    example: "123456",
    description:
      "Código OTP de 6 dígitos de la app autenticadora, o un código de respaldo.",
  })
  @IsString({ message: "El código debe ser una cadena de texto." })
  @Matches(/^[0-9a-fA-F\s-]{6,12}$/, {
    message: "El código de verificación no tiene un formato válido.",
  })
  code!: string;
}
