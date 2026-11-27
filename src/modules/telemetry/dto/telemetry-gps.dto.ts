import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from "class-validator";

/**
 * DTO de ingesta telemática GPS para el endpoint REST fallback `/telemetria/gps`
 * (Issue #12 — Riesgos y Mitigaciones).
 */
export class IngestGpsTelemetryDto {
  @ApiPropertyOptional({
    description: "Placa del vehículo homologado (ej. WKK123)",
    example: "WKK123",
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{3,16}$/, {
    message: "placa debe tener entre 3 y 16 caracteres alfanuméricos.",
  })
  placa?: string;

  @ApiPropertyOptional({
    description: "Identificador UUID del vehículo",
    example: "018e38d9-3f00-7200-a000-000000000010",
  })
  @IsOptional()
  @IsUUID()
  id_vehiculo?: string;

  @ApiPropertyOptional({
    description: "Identificador UUID del viaje en curso",
    example: "018e38d9-3f00-7200-a000-000000000030",
  })
  @IsOptional()
  @IsUUID()
  id_viaje?: string;

  @ApiProperty({
    description: "Latitud WGS84 en grados decimales (-90 a 90)",
    example: 4.8133,
  })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  latitud!: number;

  @ApiProperty({
    description: "Longitud WGS84 en grados decimales (-180 a 180)",
    example: -75.6961,
  })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  longitud!: number;

  @ApiProperty({
    description: "Velocidad instantánea del vehículo en km/h (0 a 250)",
    example: 42.5,
  })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(250)
  velocidad_kmh!: number;

  @ApiProperty({
    description:
      "Precisión horizontal GPS en metros. Lecturas > 30 m se descartan.",
    example: 8.4,
  })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  precision_metros!: number;

  @ApiProperty({
    description: "Rumbo vehicular en grados [0, 360)",
    example: 135.2,
  })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(360)
  rumbo_grados!: number;

  @ApiProperty({
    description: "Lectura acumulada del odómetro vehicular en kilómetros (>= 0)",
    example: 148250.4,
  })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  odometro_km!: number;

  @ApiPropertyOptional({
    description: "Dilución de precisión horizontal (HDOP)",
    example: 1.4,
  })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(99.99)
  precision_hdop?: number;

  @ApiPropertyOptional({
    description: "Indica si el módem opera con batería de respaldo",
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  bateria_respaldo_activa?: boolean;

  @ApiProperty({
    description: "Marca temporal UTC del paquete en formato ISO-8601",
    example: "2026-11-27T14:00:00.000Z",
  })
  @IsISO8601({ strict: true })
  timestamp!: string;
}
