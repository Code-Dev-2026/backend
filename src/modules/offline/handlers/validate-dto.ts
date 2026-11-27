import { plainToInstance } from "class-transformer";
import { validate, ValidationError } from "class-validator";

/** Campos que el procesador controla y nunca acepta del cliente dentro de `datos`. */
const SERVER_CONTROLLED_FIELDS = ["idempotency_key", "sincronizado_offline"];

/**
 * Valida `datos` con el mismo DTO y opciones que el `ValidationPipe` global HTTP
 * (whitelist + forbidNonWhitelisted + transformación implícita).
 */
export async function validateWithDto<T extends object>(
  dtoClass: new () => T,
  datos: Record<string, unknown>,
): Promise<{ value: T; errores: string[] }> {
  const sanitized = { ...datos };
  for (const field of SERVER_CONTROLLED_FIELDS) {
    delete sanitized[field];
  }
  const value = plainToInstance(dtoClass, sanitized, {
    enableImplicitConversion: true,
  });
  const errors = await validate(value, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { value, errores: flatten(errors) };
}

function flatten(errors: ValidationError[], prefix = ""): string[] {
  const out: string[] = [];
  for (const e of errors) {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    for (const message of Object.values(e.constraints ?? {})) {
      out.push(`${path}: ${message}`);
    }
    if (e.children?.length) {
      out.push(...flatten(e.children, path));
    }
  }
  return out;
}
