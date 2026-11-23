import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, Matches, MaxLength } from "class-validator";

export class VerifyOtpDto {
  @ApiProperty({
    description: "Token provisional recibido en POST /auth/login (mfaToken).",
  })
  @IsString({ message: "El token provisional debe ser una cadena de texto." })
  @IsNotEmpty({ message: "El token provisional es obligatorio." })
  @MaxLength(2048, { message: "El token provisional es demasiado largo." })
  mfaToken!: string;

  @ApiProperty({
    example: "482913",
    description: "Código OTP de 6 dígitos recibido por correo electrónico.",
  })
  @IsString({ message: "El código debe ser una cadena de texto." })
  @Matches(/^\d{6}$/, {
    message: "El código de verificación debe tener 6 dígitos.",
  })
  code!: string;
}
