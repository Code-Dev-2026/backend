import { ArgumentsHost, HttpException, HttpStatus } from "@nestjs/common";
import { AllExceptionsFilter } from "./all-exceptions.filter";

describe("AllExceptionsFilter", () => {
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
  });

  it("debe capturar HttpException y responder con formato JSON estructurado", () => {
    const mockJson = jest.fn();
    const mockStatus = jest.fn().mockReturnValue({ json: mockJson });
    const mockResponse = { status: mockStatus };
    const mockRequest = {
      url: "/api/v1/test",
      method: "GET",
      headers: {},
    };

    const mockHost = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as unknown as ArgumentsHost;

    const exception = new HttpException(
      "Recurso no encontrado",
      HttpStatus.NOT_FOUND,
    );
    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(mockJson).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.NOT_FOUND,
        path: "/api/v1/test",
        method: "GET",
        message: "Recurso no encontrado",
      }),
    );
  });

  it("debe manejar errores genéricos no controlados como 500", () => {
    const mockJson = jest.fn();
    const mockStatus = jest.fn().mockReturnValue({ json: mockJson });
    const mockHost = {
      switchToHttp: () => ({
        getResponse: () => ({ status: mockStatus }),
        getRequest: () => ({ url: "/api/v1/err", method: "POST", headers: {} }),
      }),
    } as unknown as ArgumentsHost;

    const error = new Error("Fallo crítico interno");
    filter.catch(error, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
  });
});
