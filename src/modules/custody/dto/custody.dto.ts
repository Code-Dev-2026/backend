import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { FsmCustodyState, TripDirection } from "../domain/custody.types";

export class TransitionCustodyDto {
  @ApiProperty({
    description: "UUID del viaje operativo",
    example: "018e38d9-3f00-7200-a000-000000000030",
  })
  @IsUUID()
  id_viaje!: string;

  @ApiProperty({
    description: "UUID del estudiante",
    example: "018e38d9-3f00-7200-a000-0000000000a1",
  })
  @IsUUID()
  id_estudiante!: string;

  @ApiProperty({
    enum: FsmCustodyState,
    description: "Estado de custodia destino según la FSM (Issue #7)",
    example: FsmCustodyState.EN_ESPERA_ABORDAJE,
  })
  @IsEnum(FsmCustodyState)
  estado_destino!: FsmCustodyState;

  @ApiProperty({
    enum: TripDirection,
    description: "Tipo de recorrido (MANANA o TARDE)",
    example: TripDirection.MANANA,
  })
  @IsEnum(TripDirection)
  tipo_recorrido!: TripDirection;

  @ApiPropertyOptional({
    description: "Nombre del evento disparador de la transición",
    maxLength: 50,
    example: "ABORDAJE_QR_CONFIRMADO",
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  disparador_evento?: string;

  @ApiPropertyOptional({
    description: "Latitud WGS84 opcional del punto de custodia",
    minimum: -90,
    maximum: 90,
    example: 4.8143,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitud?: number;

  @ApiPropertyOptional({
    description: "Longitud WGS84 opcional del punto de custodia",
    minimum: -180,
    maximum: 180,
    example: -75.6946,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitud?: number;
}

export class EnrollStudentTripDto {
  @ApiProperty({
    description: "UUID del estudiante a inicializar en el viaje",
    example: "018e38d9-3f00-7200-a000-0000000000a1",
  })
  @IsUUID()
  id_estudiante!: string;

  @ApiPropertyOptional({
    description: "Indica si es pasajero ocasional",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  es_pasajero_ocasional?: boolean;
}

export class InitializeMorningCustodyDto {
  @ApiPropertyOptional({
    description: "Fecha operativa en formato YYYY-MM-DD (por defecto hoy UTC)",
    example: "2026-11-23",
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: "fecha debe tener formato YYYY-MM-DD.",
  })
  fecha?: string;
}

export class VerifyIntegrityQueryDto {
  @ApiPropertyOptional({
    description: "Cantidad máxima de registros de la cadena WORM a verificar",
    minimum: 1,
    maximum: 50000,
    default: 10000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50000)
  limite?: number;
}

export class HistoryLimitQueryDto {
  @ApiPropertyOptional({
    description: "Cantidad máxima de eventos históricos a devolver",
    minimum: 1,
    maximum: 1000,
    default: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limite?: number;
}
