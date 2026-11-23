import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ROLES_KEY } from "../decorators/roles.decorator";
import { RoleEnum, userHasAnyRole } from "../enums/role.enum";
import { AuthenticatedUser } from "../decorators/current-user.decorator";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<
      (RoleEnum | string)[]
    >(ROLES_KEY, [context.getHandler(), context.getClass()]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true; // No requiere roles específicos
    }

    const { user } = context.switchToHttp().getRequest() as {
      user?: AuthenticatedUser;
    };

    if (!user || !user.roles || user.roles.length === 0) {
      throw new ForbiddenException(
        "Acceso denegado: El usuario no cuenta con roles asignados.",
      );
    }

    if (!userHasAnyRole(user.roles, requiredRoles)) {
      throw new ForbiddenException(
        `Acceso denegado: Se requiere uno de los roles: [${requiredRoles.join(", ")}]`,
      );
    }

    return true;
  }
}
