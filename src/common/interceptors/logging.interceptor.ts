import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { tap } from "rxjs/operators";
import { Request, Response } from "express";
import { sanitizeString, sanitizeUrl } from "../security/pii-sanitizer";

/**
 * Log de acceso HTTP. Solo registra metadatos (método, ruta, estado,
 * latencia); nunca el cuerpo ni las cabeceras, y la URL va sanitizada para
 * no dejar documentos, correos o tokens de los estudiantes en los logs.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger("HTTP");

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const { method, ip } = request;
    const url = sanitizeUrl(request.originalUrl ?? request.url);
    const userAgent = sanitizeString(request.get("user-agent") || "");
    const correlationId = sanitizeString(
      String(request.headers["x-correlation-id"] || "system"),
    ).slice(0, 64);
    const now = Date.now();

    return next.handle().pipe(
      tap(() => {
        const statusCode = response.statusCode;
        const delay = Date.now() - now;
        this.logger.log(
          `[${correlationId}] ${method} ${url} ${statusCode} - ${delay}ms - IP: ${ip} - UA: ${userAgent}`,
        );
      }),
    );
  }
}
