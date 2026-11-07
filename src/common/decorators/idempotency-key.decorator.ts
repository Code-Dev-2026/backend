import {
  createParamDecorator,
  ExecutionContext,
  BadRequestException,
} from "@nestjs/common";

export const IdempotencyKey = createParamDecorator(
  (required = true, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const key =
      request.headers["x-idempotency-key"] ||
      request.headers["idempotency-key"];

    if (required && !key) {
      throw new BadRequestException(
        "Cabecera X-Idempotency-Key requerida para esta operación transaccional.",
      );
    }

    return key as string;
  },
);
