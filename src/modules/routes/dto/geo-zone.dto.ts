import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { ZoneType } from "../domain/route.entity";
import { GeoJsonPolygonDto, IsGeoJsonPolygon } from "./geojson.dto";

export class CreateGeofenceZoneDto {
  @ApiPropertyOptional({ example: "PERIMETRO-PEREIRA-CENTRO" })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  codigo?: string;

  @ApiPropertyOptional({ example: "018e38d9-3f00-7200-a000-000000000002" })
  @IsOptional()
  @IsUUID("all")
  id_colegio?: string;

  @ApiProperty({ example: "Sombra Celular Corredor La Virginia" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nombre!: string;

  @ApiProperty({ enum: ZoneType, example: ZoneType.GEOCERCA_ESCOLAR })
  @IsEnum(ZoneType, {
    message:
      "tipo_zona debe ser SOMBRA_CELULAR, GEOCERCA_ESCOLAR o PERIMETRO_MUNICIPAL.",
  })
  tipo_zona!: ZoneType;

  @ApiProperty({ type: GeoJsonPolygonDto })
  @IsGeoJsonPolygon()
  poligono!: GeoJsonPolygonDto;

  @ApiPropertyOptional({
    example: "Perímetro urbano escolar de cobertura en Pereira.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  descripcion?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  activa?: boolean;
}

export class UpdateGeofenceZoneDto {
  @ApiPropertyOptional({ example: "Sede Colegio San Benito del Otún" })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nombre?: string;

  @ApiPropertyOptional({ enum: ZoneType })
  @IsOptional()
  @IsEnum(ZoneType)
  tipo_zona?: ZoneType;

  @ApiPropertyOptional({ type: GeoJsonPolygonDto })
  @IsOptional()
  @IsGeoJsonPolygon()
  poligono?: GeoJsonPolygonDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  descripcion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activa?: boolean;
}

export class ListZonesQueryDto {
  @ApiPropertyOptional({ enum: ZoneType })
  @IsOptional()
  @IsEnum(ZoneType)
  tipo_zona?: ZoneType;

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

export class NearbyStopsQueryDto {
  @ApiProperty({
    description: "Latitud WGS84 [-90, 90] (OWASP ASVS V5.1)",
    example: 4.8133,
    minimum: -90,
    maximum: 90,
  })
  @Type(() => Number)
  @IsNumber()
  @Min(-90, { message: "latitud debe estar entre -90 y 90." })
  @Max(90, { message: "latitud debe estar entre -90 y 90." })
  latitud!: number;

  @ApiProperty({
    description: "Longitud WGS84 [-180, 180] (OWASP ASVS V5.1)",
    example: -75.6961,
    minimum: -180,
    maximum: 180,
  })
  @Type(() => Number)
  @IsNumber()
  @Min(-180, { message: "longitud debe estar entre -180 y 180." })
  @Max(180, { message: "longitud debe estar entre -180 y 180." })
  longitud!: number;

  @ApiPropertyOptional({
    description: "Radio de búsqueda en metros (ST_DWithin)",
    example: 500,
    minimum: 1,
    maximum: 50000,
    default: 500,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(50000)
  radio_metros: number = 500;

  @ApiPropertyOptional({
    description: "Filtro opcional por ruta escolar",
    example: "018e38d9-3f00-7200-a000-000000000020",
  })
  @IsOptional()
  @IsUUID("all")
  id_ruta?: string;
}

export class CalculateDistanceDto {
  @ApiProperty({ example: 4.8133, minimum: -90, maximum: 90 })
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  origen_latitud!: number;

  @ApiProperty({ example: -75.6961, minimum: -180, maximum: 180 })
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  origen_longitud!: number;

  @ApiProperty({ example: 4.8143, minimum: -90, maximum: 90 })
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  destino_latitud!: number;

  @ApiProperty({ example: -75.6946, minimum: -180, maximum: 180 })
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  destino_longitud!: number;
}

export class CheckGeofenceContainmentDto {
  @ApiProperty({ example: 4.8143, minimum: -90, maximum: 90 })
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitud!: number;

  @ApiProperty({ example: -75.6946, minimum: -180, maximum: 180 })
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitud!: number;

  @ApiPropertyOptional({ enum: ZoneType })
  @IsOptional()
  @IsEnum(ZoneType)
  tipo_zona?: ZoneType;
}
