import { ExecutionContext, CallHandler } from "@nestjs/common";
import { of } from "rxjs";
import { TransformInterceptor } from "./transform.interceptor";

describe("TransformInterceptor", () => {
  let interceptor: TransformInterceptor<unknown>;

  beforeEach(() => {
    interceptor = new TransformInterceptor();
  });

  it("debe envolver la respuesta en el formato estándar { success, statusCode, data }", (done) => {
    const mockContext = {
      switchToHttp: () => ({
        getResponse: () => ({ statusCode: 200 }),
      }),
    } as unknown as ExecutionContext;

    const mockHandler: CallHandler = {
      handle: () => of({ test: "valor" }),
    };

    interceptor.intercept(mockContext, mockHandler).subscribe({
      next: (result) => {
        expect(result.success).toBe(true);
        expect(result.statusCode).toBe(200);
        expect(result.data).toEqual({ test: "valor" });
        expect(result.timestamp).toBeDefined();
        done();
      },
    });
  });
});
