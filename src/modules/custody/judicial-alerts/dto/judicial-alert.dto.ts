import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";

export class CreateJudicialAlertDto {
  @ApiProperty({
    description: "UUID del estudiante protegido por la medida cautelar",
    example: "018e38d9-3f00-7200-a000-000000001001",
  })
  @IsUUID()
  id_estudiante!: string;

  @ApiProperty({
    description: "Juzgado de Familia o Comisaría emisora de la medida cautelar",
    example: "Comisaría Primera de Familia de Pereira",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  juzgado_emisor!: string;

  @ApiProperty({
    description: "Radicado oficial único de la orden o medida judicial",
    example: "CFP-2026-00145",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  radicado_medida!: string;

  @ApiProperty({
    description:
      "Nombre completo del individuo restringido (se cifra en reposo con AES-256-GCM)",
    example: "Carlos Alberto Restrepo",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  individuo_restringido_nombre!: string;

  @ApiProperty({
    description:
      "Documento de identidad del individuo restringido (se cifra con AES-256-GCM y genera blind index HMAC-SHA256)",
    example: "79123456",
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(4)
  @MaxLength(40)
  individuo_restringido_documento!: string;

  @ApiProperty({
    description:
      "Resumen de la orden judicial cautelar (se cifra en reposo con AES-256-GCM)",
    example:
      "Medida de protección vigente: prohibición absoluta de retiro o acercamiento al menor.",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  orden_judicial_resumen!: string;

  @ApiPropertyOptional({
    description:
      "Referencia o URI interna de la fotografía del individuo restringido (se cifra con AES-256-GCM)",
    example: "vault://judicial/CFP-2026-00145/foto.jpg",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  foto_individuo_referencia?: string;
}

export class VerifyJudicialAlertDto {
  @ApiProperty({
    description: "UUID del estudiante a entregar",
    example: "018e38d9-3f00-7200-a000-000000001001",
  })
  @IsUUID()
  id_estudiante!: string;

  @ApiPropertyOptional({
    description:
      "Documento en claro digitado o escaneado en parada (se normaliza y convierte a blind index HMAC-SHA256 en memoria)",
    example: "79123456",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  documento_receptor?: string;

  @ApiPropertyOptional({
    description:
      "Blind index HMAC-SHA256 (64 hex) alternativo para consulta determinista directa",
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-fA-F0-9]{64}$/, {
    message:
      "documento_restringido_hash debe ser un hash hexadecimal HMAC-SHA256 de 64 caracteres.",
  })
  documento_restringido_hash?: string;
}

export class DeactivateJudicialAlertDto {
  @ApiPropertyOptional({
    description: "UUID del coordinador que autoriza el levantamiento en sistema",
    example: "018e38d9-3f00-7200-a000-000000009001",
  })
  @IsOptional()
  @IsUUID()
  eliminado_por_coordinacion?: string;

  @ApiPropertyOptional({
    description:
      "Referencia de la providencia judicial o autoridad que ordena el levantamiento",
    example: "Auto de levantamiento No. 089 - Comisaría Primera de Familia",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  autorizado_excepcion_por?: string;
}

export class ListJudicialAlertsQueryDto {
  @ApiPropertyOptional({
    description: "Incluir alertas desactivadas (soft-deleted) en el listado",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  incluir_inactivas?: boolean;
}
