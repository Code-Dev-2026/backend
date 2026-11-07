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

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger("HTTP");

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const { method, url, ip } = request;
    const userAgent = request.get("user-agent") || "";
    const correlationId = request.headers["x-correlation-id"] || "system";
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
