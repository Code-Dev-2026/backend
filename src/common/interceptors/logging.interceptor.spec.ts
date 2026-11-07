import { ExecutionContext, CallHandler } from "@nestjs/common";
import { of } from "rxjs";
import { LoggingInterceptor } from "./logging.interceptor";

describe("LoggingInterceptor", () => {
  let interceptor: LoggingInterceptor;

  beforeEach(() => {
    interceptor = new LoggingInterceptor();
  });

  it("debe registrar la petición y continuar con la ejecución", (done) => {
    const mockRequest = {
      method: "GET",
      url: "/api/v1/health",
      ip: "127.0.0.1",
      get: jest.fn().mockReturnValue("Jest-Agent"),
      headers: { "x-correlation-id": "test-correlation-id" },
    };

    const mockResponse = {
      statusCode: 200,
    };

    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
        getResponse: () => mockResponse,
      }),
    } as unknown as ExecutionContext;

    const mockHandler: CallHandler = {
      handle: () => of("ok"),
    };

    interceptor.intercept(mockContext, mockHandler).subscribe({
      next: (val) => {
        expect(val).toBe("ok");
        done();
      },
    });
  });
});
