import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsObject,
  IsUUID,
  Matches,
  ValidateNested,
} from "class-validator";
import { MAX_OPERATIONS_PER_BATCH } from "../domain/offline-sync.ports";
import { OfflineOperationType } from "../domain/offline-sync.types";

const OPERATION_TYPES: OfflineOperationType[] = ["ABORDAJE", "DESCENSO"];

export class OfflineOperationDto {
  @ApiProperty({
    description:
      "Clave idempotente generada en el dispositivo por operación (única por dispositivo).",
    example: "018e38d9-3f00-7200-a000-0000000a0001",
  })
  @Matches(/^[A-Za-z0-9._:-]{8,64}$/, {
    message:
      "idempotency_key debe tener 8–64 caracteres alfanuméricos o . _ : -",
  })
  idempotency_key!: string;

  @ApiProperty({ enum: OPERATION_TYPES, example: "ABORDAJE" })
  @IsIn(OPERATION_TYPES)
  tipo!: OfflineOperationType;

  @ApiProperty({
    description:
      "Marca de tiempo local del dispositivo al capturar el evento (ISO-8601).",
    example: "2026-11-27T12:05:31.000Z",
  })
  @IsISO8601({ strict: true })
  fecha_cliente!: string;

  @ApiProperty({
    description:
      "Payload del caso de uso: el mismo cuerpo de POST /asistencia/abordaje o /asistencia/descenso.",
    type: Object,
  })
  @IsObject()
  datos!: Record<string, unknown>;
}

export class OfflineSyncBatchDto {
  @ApiProperty({
    description:
      "Dispositivo registrado en `dispositivo` y asignado al usuario autenticado.",
    example: "018e38d9-3f00-7200-a000-0000000d0001",
  })
  @IsUUID()
  id_dispositivo!: string;

  @ApiProperty({ type: [OfflineOperationDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_OPERATIONS_PER_BATCH)
  @ValidateNested({ each: true })
  @Type(() => OfflineOperationDto)
  operaciones!: OfflineOperationDto[];
}
