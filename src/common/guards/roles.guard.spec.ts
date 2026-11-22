import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RolesGuard } from "./roles.guard";
import { RoleEnum } from "../enums/role.enum";

describe("RolesGuard (RBAC)", () => {
  let guard: RolesGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  const createMockContext = (user?: unknown) => {
    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: jest.fn().mockReturnValue({
        getRequest: jest.fn().mockReturnValue({ user }),
      }),
    } as unknown as ExecutionContext;
  };

  it("debe permitir acceso si la ruta no define roles requeridos", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(undefined);
    const context = createMockContext();
    expect(guard.canActivate(context)).toBe(true);
  });

  it("debe arrojar ForbiddenException si el usuario no tiene roles", () => {
    jest
      .spyOn(reflector, "getAllAndOverride")
      .mockReturnValue([RoleEnum.COORDINADORA_CONVIVENCIA]);
    const context = createMockContext({ id_usuario: "1", roles: [] });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it("debe permitir acceso si el usuario tiene el rol requerido", () => {
    jest
      .spyOn(reflector, "getAllAndOverride")
      .mockReturnValue([RoleEnum.COORDINADORA_CONVIVENCIA]);
    const context = createMockContext({
      id_usuario: "1",
      roles: [RoleEnum.COORDINADORA_CONVIVENCIA],
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it("debe permitir acceso mediante alias RBAC equivalente", () => {
    jest
      .spyOn(reflector, "getAllAndOverride")
      .mockReturnValue([RoleEnum.SUPER_ADMIN]);
    const context = createMockContext({
      id_usuario: "1",
      roles: [RoleEnum.COORDINADORA_CONVIVENCIA],
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it("debe denegar acceso si el usuario no cuenta con el rol requerido", () => {
    jest
      .spyOn(reflector, "getAllAndOverride")
      .mockReturnValue([RoleEnum.COORDINADORA_CONVIVENCIA]);
    const context = createMockContext({
      id_usuario: "1",
      roles: [RoleEnum.ACUDIENTE],
    });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it("@Roles('ADMIN') permite a la coordinadora (superadministradora)", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["ADMIN"]);
    const context = createMockContext({
      id_usuario: "1",
      roles: [RoleEnum.COORDINADORA_CONVIVENCIA],
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it.each([RoleEnum.MONITORA, RoleEnum.CONDUCTOR, RoleEnum.ACUDIENTE])(
    "@Roles('ADMIN') deniega con 403 al rol %s",
    (rol) => {
      jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["ADMIN"]);
      const context = createMockContext({ id_usuario: "1", roles: [rol] });
      try {
        guard.canActivate(context);
        fail("Se esperaba ForbiddenException");
      } catch (error) {
        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).getStatus()).toBe(403);
      }
    },
  );
});
