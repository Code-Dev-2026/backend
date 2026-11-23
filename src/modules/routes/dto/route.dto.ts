import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { AssignmentCycle, RouteShift } from "../domain/route.entity";
import {
  GeoJsonLineStringDto,
  GeoJsonPointDto,
  GeoJsonPolygonDto,
  IsGeoJsonLineString,
  IsGeoJsonPoint,
  IsGeoJsonPolygon,
} from "./geojson.dto";

const TIME_HH_MM_SS_REGEX = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export class CreateRouteDto {
  @ApiProperty({ example: "018e38d9-3f00-7200-a000-000000000002" })
  @IsUUID("all", { message: "id_colegio debe ser un UUID válido." })
  id_colegio!: string;

  @ApiProperty({ example: "018e38d9-3f00-7200-a000-000000000003" })
  @IsUUID("all", { message: "id_empresa debe ser un UUID válido." })
  id_empresa!: string;

  @ApiProperty({ example: "R-01" })
  @IsString()
  @IsNotEmpty({ message: "El código de la ruta es obligatorio." })
  @MaxLength(20)
  codigo!: string;

  @ApiProperty({ example: "Ruta Pinares - San Benito del Otún" })
  @IsString()
  @IsNotEmpty({ message: "El nombre de la ruta es obligatorio." })
  @MaxLength(100)
  nombre!: string;

  @ApiProperty({ enum: RouteShift, example: RouteShift.MANANA })
  @IsEnum(RouteShift, {
    message: "jornada debe ser MANANA, TARDE o COMPLETA.",
  })
  jornada!: RouteShift;

  @ApiProperty({ type: GeoJsonLineStringDto })
  @IsGeoJsonLineString()
  polilinea_oficial!: GeoJsonLineStringDto;

  @ApiProperty({ example: "Parque Los Álamos" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  origen_nombre!: string;

  @ApiProperty({ example: "Colegio San Benito del Otún" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  destino_nombre!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  activa?: boolean;
}

export class UpdateRouteDto {
  @ApiPropertyOptional({ example: "Ruta Pinares - Circunvalar" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nombre?: string;

  @ApiPropertyOptional({ enum: RouteShift })
  @IsOptional()
  @IsEnum(RouteShift)
  jornada?: RouteShift;

  @ApiPropertyOptional({ type: GeoJsonLineStringDto })
  @IsOptional()
  @IsGeoJsonLineString()
  polilinea_oficial?: GeoJsonLineStringDto;

  @ApiPropertyOptional({ example: "Parque Los Álamos" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  origen_nombre?: string;

  @ApiPropertyOptional({ example: "Sede San Benito del Otún" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  destino_nombre?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activa?: boolean;
}

export class ListRoutesQueryDto {
  @ApiPropertyOptional({ example: "018e38d9-3f00-7200-a000-000000000002" })
  @IsOptional()
  @IsUUID("all")
  id_colegio?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === "true" || value === true) return true;
    if (value === "false" || value === false) return false;
    return value;
  })
  @IsBoolean()
  activa?: boolean;
}

export class CreateStopDto {
  @ApiProperty({ example: "Parque Los Álamos" })
  @IsString()
  @IsNotEmpty({ message: "El nombre de la parada es obligatorio." })
  @MaxLength(100)
  nombre!: string;

  @ApiProperty({ example: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: "orden_secuencia debe ser mayor o igual a 1." })
  orden_secuencia!: number;

  @ApiProperty({ type: GeoJsonPointDto })
  @IsGeoJsonPoint()
  punto_geografico!: GeoJsonPointDto;

  @ApiProperty({ example: "06:30:00" })
  @IsString()
  @Matches(TIME_HH_MM_SS_REGEX, {
    message: "horario_estimado debe tener formato HH:mm o HH:mm:ss.",
  })
  horario_estimado!: string;

  @ApiPropertyOptional({
    description:
      "Polígono GeoJSON explícito de geocerca de parada. Si se omite, se genera desde radio_metros.",
    type: GeoJsonPolygonDto,
  })
  @IsOptional()
  @IsGeoJsonPolygon()
  radio_geocerca?: GeoJsonPolygonDto;

  @ApiPropertyOptional({
    description:
      "Radio en metros para generar automáticamente el polígono de geocerca si no se envía radio_geocerca.",
    example: 100,
    minimum: 10,
    maximum: 5000,
    default: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(10)
  @Max(5000)
  radio_metros?: number;
}

export class UpdateStopDto {
  @ApiPropertyOptional({ example: "Av. Circunvalar Calle 14" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nombre?: string;

  @ApiPropertyOptional({ example: 2, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  orden_secuencia?: number;

  @ApiPropertyOptional({ type: GeoJsonPointDto })
  @IsOptional()
  @IsGeoJsonPoint()
  punto_geografico?: GeoJsonPointDto;

  @ApiPropertyOptional({ example: "06:45:00" })
  @IsOptional()
  @IsString()
  @Matches(TIME_HH_MM_SS_REGEX)
  horario_estimado?: string;

  @ApiPropertyOptional({ type: GeoJsonPolygonDto })
  @IsOptional()
  @IsGeoJsonPolygon()
  radio_geocerca?: GeoJsonPolygonDto;

  @ApiPropertyOptional({ example: 120, minimum: 10, maximum: 5000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(10)
  @Max(5000)
  radio_metros?: number;
}

export class CreateRouteAssignmentDto {
  @ApiProperty({ example: "018e38d9-3f00-7200-a000-0000000000a1" })
  @IsUUID("all", { message: "id_estudiante debe ser un UUID válido." })
  id_estudiante!: string;

  @ApiProperty({ example: "018e38d9-3f00-7200-a000-000000000021" })
  @IsUUID("all", { message: "id_parada_subida debe ser un UUID válido." })
  id_parada_subida!: string;

  @ApiProperty({ example: "018e38d9-3f00-7200-a000-000000000023" })
  @IsUUID("all", { message: "id_parada_bajada debe ser un UUID válido." })
  id_parada_bajada!: string;

  @ApiProperty({ enum: AssignmentCycle, example: AssignmentCycle.AMBOS })
  @IsEnum(AssignmentCycle, {
    message: "ciclo_horario debe ser IDA, RETORNO o AMBOS.",
  })
  ciclo_horario!: AssignmentCycle;
}
