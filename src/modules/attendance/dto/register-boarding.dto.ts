import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { BoardingValidationMethod } from "../domain/attendance.types";

export class BoardingCoordinatesDto {
  @ApiProperty({
    description: "Latitud WGS84 del punto de abordaje",
    example: 4.8133,
    minimum: -90,
    maximum: 90,
  })
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitud!: number;

  @ApiProperty({
    description: "Longitud WGS84 del punto de abordaje",
    example: -75.6961,
    minimum: -180,
    maximum: 180,
  })
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitud!: number;
}

export class RegisterBoardingDto {
  @ApiProperty({
    description: "UUID del viaje en estado EN_CURSO",
    example: "018e38d9-3f00-7200-a000-000000000501",
  })
  @IsUUID()
  id_viaje!: string;

  @ApiProperty({
    description:
      "Código QR escaneado (estático institucional, ocasional temporal o dinámico firmado HMAC)",
    example: "QR-EST-2026-0001",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  qr_token!: string;

  @ApiProperty({
    description: "Coordenadas GPS WGS84 del escaneo de abordaje",
    type: BoardingCoordinatesDto,
  })
  @IsDefined()
  @ValidateNested()
  @Type(() => BoardingCoordinatesDto)
  coordenadas_gps!: BoardingCoordinatesDto;

  @ApiPropertyOptional({
    description: "UUID opcional de la parada de abordaje",
    example: "018e38d9-3f00-7200-a000-000000000201",
  })
  @IsOptional()
  @IsUUID()
  id_parada?: string;

  @ApiPropertyOptional({
    description: "Método de validación reportado por el dispositivo móvil",
    enum: [
      "QR_INSTITUCIONAL",
      "QR_OCASIONAL_TEMPORAL",
      "VERIFICACION_VISUAL_PARADA",
    ],
    default: "QR_INSTITUCIONAL",
  })
  @IsOptional()
  @IsIn([
    "QR_INSTITUCIONAL",
    "QR_OCASIONAL_TEMPORAL",
    "VERIFICACION_VISUAL_PARADA",
  ])
  metodo_validacion?: BoardingValidationMethod;

  @ApiPropertyOptional({
    description: "Indica si el escaneo proviene de sincronización offline",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  sincronizado_offline?: boolean;

  @ApiPropertyOptional({
    description:
      "Clave idempotente opcional (también aceptada vía cabecera X-Idempotency-Key)",
    example: "scan-viaje-1-est-1-001",
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  idempotency_key?: string;
}
