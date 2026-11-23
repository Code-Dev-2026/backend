import { ApiProperty, ApiPropertyOptional, OmitType } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

/** Documento: dígitos/letras, admite puntos, guiones y espacios de formato. */
const DOCUMENTO_REGEX = /^[0-9A-Za-z][0-9A-Za-z.\- ]{4,24}$/;

export class CreateStudentDto {
  @ApiProperty({ example: "018e38d9-3f00-7200-a000-0000000000c1" })
  @IsUUID("all", { message: "id_colegio debe ser un UUID válido." })
  id_colegio!: string;

  @ApiProperty({ example: "EST-2026-089" })
  @IsString()
  @IsNotEmpty({ message: "El código institucional es obligatorio." })
  @MaxLength(30)
  codigo_institucional!: string;

  @ApiProperty({ example: "Mateo Gómez Restrepo" })
  @IsString()
  @IsNotEmpty({ message: "El nombre completo es obligatorio." })
  @MaxLength(150)
  nombre_completo!: string;

  @ApiProperty({ example: "1088123456" })
  @IsString()
  @Matches(DOCUMENTO_REGEX, {
    message: "El documento de identidad no tiene un formato válido.",
  })
  documento_identidad!: string;

  @ApiProperty({ example: "Calle 10 # 5-20, Pereira" })
  @IsString()
  @IsNotEmpty({ message: "La dirección es obligatoria." })
  @MaxLength(200)
  direccion!: string;

  @ApiPropertyOptional({ example: "Asma leve; inhalador en la maleta." })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  condiciones_medicas?: string;

  @ApiProperty({ example: "4A" })
  @IsString()
  @IsNotEmpty({ message: "El grado es obligatorio." })
  @MaxLength(20)
  grado!: string;
}

/**
 * Búsqueda por documento. Va en el CUERPO de un POST (no en la URL) para
 * que el documento no quede en logs de acceso, proxies ni historial.
 */
export class SearchStudentByDocumentDto {
  @ApiProperty({ example: "1088123456" })
  @IsString()
  @Matches(DOCUMENTO_REGEX, {
    message: "El documento de identidad no tiene un formato válido.",
  })
  documento!: string;
}

export class ListStudentsQueryDto {
  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

/**
 * Una fila del archivo de matrículas: mismas reglas que el alta individual,
 * sin id_colegio (llega una sola vez en el formulario de importación).
 */
export class ImportStudentRowDto extends OmitType(CreateStudentDto, [
  "id_colegio",
] as const) {}

/** Campos de formulario que acompañan al archivo en POST /students/import. */
export class ImportStudentsDto {
  @ApiProperty({ example: "018e38d9-3f00-7200-a000-000000000002" })
  @IsUUID("all", { message: "id_colegio debe ser un UUID válido." })
  id_colegio!: string;
}
