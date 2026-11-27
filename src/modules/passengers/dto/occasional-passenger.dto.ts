import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

export class RequestOccasionalPassengerDto {
  @ApiProperty({
    description: "UUID del estudiante para quien se solicita el cupo ocasional",
    example: "018e38d9-3f00-7200-a000-000000001001",
  })
  @IsUUID()
  id_estudiante!: string;

  @ApiProperty({
    description: "UUID del viaje programado en el cual se solicita el cupo",
    example: "018e38d9-3f00-7200-a000-000000000101",
  })
  @IsUUID()
  id_viaje!: string;

  @ApiPropertyOptional({
    description: "Motivo académico o familiar de la solicitud ocasional",
    example: "Actividad académica extracurricular autorizada por acudiente.",
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  motivo?: string;
}

export class ApproveOccasionalPassengerDto {
  @ApiProperty({
    description: "UUID de la solicitud de pasajero ocasional en estado RADICADA",
    example: "018e38d9-3f00-7200-a000-000000009001",
  })
  @IsUUID()
  id_pasajero_ocasional!: string;

  @ApiPropertyOptional({
    description:
      "UUID explícito del perfil coordinador (si se omite, se resuelve a partir del usuario autenticado)",
    example: "018e38d9-3f00-7200-a000-000000000070",
  })
  @IsOptional()
  @IsUUID()
  id_coordinador?: string;
}
