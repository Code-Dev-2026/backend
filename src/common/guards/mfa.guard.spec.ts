import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { MfaGuard } from "./mfa.guard";
import { RoleEnum } from "../enums/role.enum";

describe("MfaGuard (Doble Factor Obligatorio)", () => {
  let guard: MfaGuard;

  beforeEach(() => {
    guard = new MfaGuard();
  });

  const createMockContext = (user?: unknown) => {
    return {
      switchToHttp: jest.fn().mockReturnValue({
        getRequest: jest.fn().mockReturnValue({ user }),
      }),
    } as unknown as ExecutionContext;
  };

  it("debe arrojar UnauthorizedException si no hay usuario autenticado", () => {
    const context = createMockContext(undefined);
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it("debe permitir acceso si el rol no requiere MFA obligatorio", () => {
    const context = createMockContext({
      id_usuario: "1",
      roles: [RoleEnum.MONITORA],
      mfa_autenticado: false,
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it("debe arrojar UnauthorizedException si el rol requiere MFA y no está autenticado", () => {
    const context = createMockContext({
      id_usuario: "1",
      roles: [RoleEnum.COORDINADORA_CONVIVENCIA],
      mfa_autenticado: false,
    });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it("debe permitir acceso si el rol requiere MFA y ya validó TOTP", () => {
    const context = createMockContext({
      id_usuario: "1",
      roles: [RoleEnum.COORDINADORA_CONVIVENCIA],
      mfa_autenticado: true,
    });
    expect(guard.canActivate(context)).toBe(true);
  });
});
