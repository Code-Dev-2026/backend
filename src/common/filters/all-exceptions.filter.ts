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
import { sanitize, sanitizeUrl } from "../security/pii-sanitizer";

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
    let errorCode: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === "string") {
        message = res;
      } else if (typeof res === "object" && res !== null) {
        const resObj = res as {
          message?: string | object;
          error?: string;
          code?: string;
        };
        message = resObj.message || res;
        errorName = resObj.error || exception.name;
        if (typeof resObj.code === "string" && resObj.code.length > 0) {
          errorCode = resObj.code;
        }
      }
    } else if (exception instanceof Error) {
      errorName = exception.name;
      // En producción no exponer stack traces ni detalles SQL internos
      if (process.env.NODE_ENV === "development") {
        message = exception.message;
      }
    }

    // El log va sanitizado: los mensajes de validación pueden repetir el
    // valor recibido (p. ej. un documento) y la URL puede contener PII.
    this.logger.error(
      `[${correlationId}] ${request.method} ${sanitizeUrl(request.url)} - Status ${status} - Error: ${JSON.stringify(sanitize(message))}`,
      exception instanceof Error
        ? (sanitize(exception) as Error).stack
        : undefined,
    );

    response.status(status).json({
      statusCode: status,
      ...(errorCode ? { code: errorCode } : {}),
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      correlationId,
      error: errorName,
      message,
    });
  }
}
