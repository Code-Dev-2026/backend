import { ApiProperty } from "@nestjs/swagger";
import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import {
  GeoJsonLineString,
  GeoJsonPoint,
  GeoJsonPolygon,
  GeoJsonPosition,
  isValidGeoJsonLineString,
  isValidGeoJsonPoint,
  isValidGeoJsonPolygon,
} from "../domain/geo.types";

@ValidatorConstraint({ name: "isGeoJsonPoint", async: false })
class GeoJsonPointConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isValidGeoJsonPoint(value);
  }

  defaultMessage(): string {
    return "Debe ser un GeoJSON Point válido con [longitud (-180..180), latitud (-90..90)].";
  }
}

@ValidatorConstraint({ name: "isGeoJsonLineString", async: false })
class GeoJsonLineStringConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isValidGeoJsonLineString(value);
  }

  defaultMessage(): string {
    return "Debe ser un GeoJSON LineString válido con al menos 2 coordenadas [longitud (-180..180), latitud (-90..90)].";
  }
}

@ValidatorConstraint({ name: "isGeoJsonPolygon", async: false })
class GeoJsonPolygonConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isValidGeoJsonPolygon(value);
  }

  defaultMessage(): string {
    return "Debe ser un GeoJSON Polygon cerrado válido (mínimo 4 posiciones, primer y último vértice iguales, rangos WGS84 lat [-90,90] y lng [-180,180]).";
  }
}

export function IsGeoJsonPoint(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: GeoJsonPointConstraint,
    });
  };
}

export function IsGeoJsonLineString(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: GeoJsonLineStringConstraint,
    });
  };
}

export function IsGeoJsonPolygon(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: GeoJsonPolygonConstraint,
    });
  };
}

export class GeoJsonPointDto implements GeoJsonPoint {
  @ApiProperty({ example: "Point", enum: ["Point"] })
  type!: "Point";

  @ApiProperty({
    description: "Coordenada WGS84 en orden GeoJSON [longitud, latitud]",
    example: [-75.6961, 4.8133],
    type: [Number],
  })
  coordinates!: GeoJsonPosition;
}

export class GeoJsonLineStringDto implements GeoJsonLineString {
  @ApiProperty({ example: "LineString", enum: ["LineString"] })
  type!: "LineString";

  @ApiProperty({
    description: "Secuencia de coordenadas WGS84 [[longitud, latitud], ...]",
    example: [
      [-75.6961, 4.8133],
      [-75.6922, 4.8155],
      [-75.6946, 4.8143],
    ],
    type: "array",
    items: { type: "array", items: { type: "number" } },
  })
  coordinates!: GeoJsonPosition[];
}

export class GeoJsonPolygonDto implements GeoJsonPolygon {
  @ApiProperty({ example: "Polygon", enum: ["Polygon"] })
  type!: "Polygon";

  @ApiProperty({
    description:
      "Anillos cerrados GeoJSON [[[lng, lat], ...]] en WGS84 (SRID 4326)",
    example: [
      [
        [-75.69595, 4.81295],
        [-75.69325, 4.81295],
        [-75.69325, 4.81565],
        [-75.69595, 4.81565],
        [-75.69595, 4.81295],
      ],
    ],
    type: "array",
    items: {
      type: "array",
      items: { type: "array", items: { type: "number" } },
    },
  })
  coordinates!: GeoJsonPosition[][];
}
