import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsDefined,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { BoardingValidationMethod } from "../domain/attendance.types";
import { DisembarkOutcomeType, ReceptorType } from "../domain/disembark.types";
import { BoardingCoordinatesDto } from "./register-boarding.dto";

export class RegisterDisembarkDto {
  @ApiProperty({
    description: "UUID del viaje en estado EN_CURSO",
    example: "018e38d9-3f00-7200-a000-000000000501",
  })
  @IsUUID()
  id_viaje!: string;

  @ApiProperty({
    description:
      "UUID del estudiante individual a entregar (validación independiente por menor)",
    example: "018e38d9-3f00-7200-a000-000000001001",
  })
  @IsUUID()
  id_estudiante!: string;

  @ApiPropertyOptional({
    description:
      "Resultado de la entrega en parada: ENTREGADO_EXITOSO o DESEMBARQUE_FALLIDO_RETORNO",
    enum: DisembarkOutcomeType,
    default: DisembarkOutcomeType.ENTREGADO_EXITOSO,
  })
  @IsOptional()
  @IsEnum(DisembarkOutcomeType)
  resultado_entrega?: DisembarkOutcomeType;

  @ApiPropertyOptional({
    description:
      "Tipo de receptor acreditado (obligatorio cuando resultado_entrega = ENTREGADO_EXITOSO)",
    enum: ReceptorType,
  })
  @IsOptional()
  @IsEnum(ReceptorType)
  tipo_receptor?: ReceptorType;

  @ApiPropertyOptional({
    description:
      "Documento de identidad del receptor (se normaliza y convierte a blind index HMAC-SHA256 en memoria)",
    example: "1088123456",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  documento_receptor?: string;

  @ApiPropertyOptional({
    description:
      "Blind index HMAC-SHA256 (64 hex) alternativo cuando el cliente móvil precalcula o reenvía índice",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  documento_blind_index?: string;

  @ApiPropertyOptional({
    description:
      "UUID opcional del receptor (id_acudiente o id_autorizado) para doble cotejo de identidad",
  })
  @IsOptional()
  @IsUUID()
  id_receptor?: string;

  @ApiPropertyOptional({
    description: "Método de validación empleado en parada",
    enum: [
      "QR_INSTITUCIONAL",
      "QR_OCASIONAL_TEMPORAL",
      "VERIFICACION_VISUAL_PARADA",
    ],
    default: "VERIFICACION_VISUAL_PARADA",
  })
  @IsOptional()
  @IsIn([
    "QR_INSTITUCIONAL",
    "QR_OCASIONAL_TEMPORAL",
    "VERIFICACION_VISUAL_PARADA",
  ])
  metodo_validacion?: BoardingValidationMethod;

  @ApiProperty({
    description: "Coordenadas GPS WGS84 del punto de desembarque o no-entrega",
    type: BoardingCoordinatesDto,
  })
  @IsDefined()
  @ValidateNested()
  @Type(() => BoardingCoordinatesDto)
  coordenadas_gps!: BoardingCoordinatesDto;

  @ApiPropertyOptional({
    description: "URL opcional de evidencia fotográfica de entrega",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  foto_evidencia_url?: string;

  @ApiPropertyOptional({
    description:
      "Observaciones obligatorias recomendadas cuando se reporta DESEMBARQUE_FALLIDO_RETORNO",
    example: "Ningún adulto autorizado compareció en el domicilio tras 5 minutos.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  observaciones_fallido?: string;

  @ApiPropertyOptional({
    description: "Indica si el evento proviene de sincronización offline",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  sincronizado_offline?: boolean;

  @ApiPropertyOptional({
    description:
      "Clave idempotente opcional (también aceptada vía cabecera X-Idempotency-Key)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  idempotency_key?: string;
}

export class FinalizeSchoolCustodyDto {
  @ApiProperty({
    description: "UUID del viaje en estado EN_CURSO que retorna al colegio",
    example: "018e38d9-3f00-7200-a000-000000000501",
  })
  @IsUUID()
  id_viaje!: string;

  @ApiProperty({
    description:
      "UUID del estudiante en estado RETORNO_SEDE_POR_FALLA_ENTREGA recibido en sede",
    example: "018e38d9-3f00-7200-a000-000000001001",
  })
  @IsUUID()
  id_estudiante!: string;

  @ApiProperty({
    description:
      "UUID del coordinador (tabla coordinador) que certifica la recepción formal en el colegio",
    example: "018e38d9-3f00-7200-a000-000000009001",
  })
  @IsUUID()
  recibido_por_coordinador!: string;

  @ApiProperty({
    description: "Coordenadas GPS WGS84 de la recepción formal en la sede",
    type: BoardingCoordinatesDto,
  })
  @IsDefined()
  @ValidateNested()
  @Type(() => BoardingCoordinatesDto)
  coordenadas_gps!: BoardingCoordinatesDto;

  @ApiPropertyOptional({
    description: "Observaciones del acta de custodia en coordinación/rectoría",
    example:
      "Menor recibido sin novedad en Coordinación de Convivencia; acudiente contactado.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  observaciones?: string;

  @ApiPropertyOptional({
    description:
      "Clave idempotente opcional (también aceptada vía cabecera X-Idempotency-Key)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  idempotency_key?: string;
}
