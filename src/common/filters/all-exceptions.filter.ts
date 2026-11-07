import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Request, Response } from "express";
import * as crypto from "crypto";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const correlationId =
      (request.headers["x-correlation-id"] as string) || crypto.randomUUID();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | object = "Error interno del servidor";
    let errorName = "InternalServerError";

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === "string") {
        message = res;
      } else if (typeof res === "object" && res !== null) {
        message = (res as { message?: string | object }).message || res;
        errorName = (res as { error?: string }).error || exception.name;
      }
    } else if (exception instanceof Error) {
      errorName = exception.name;
      // En producción no exponer stack traces ni detalles SQL internos
      if (process.env.NODE_ENV === "development") {
        message = exception.message;
      }
    }

    this.logger.error(
      `[${correlationId}] ${request.method} ${request.url} - Status ${status} - Error: ${JSON.stringify(message)}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      correlationId,
      error: errorName,
      message,
    });
  }
}
