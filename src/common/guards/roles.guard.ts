import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ROLES_KEY } from "../decorators/roles.decorator";
import { ROLE_EQUIVALENCES, RoleEnum } from "../enums/role.enum";
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

    // Expandir roles requeridos con sus equivalencias
    const allowedSet = new Set<string>();
    for (const role of requiredRoles) {
      allowedSet.add(role);
      const equivalents = ROLE_EQUIVALENCES[role];
      if (equivalents) {
        equivalents.forEach((eq) => allowedSet.add(eq));
      }
    }

    // Verificar si algún rol del usuario coincide con los permitidos
    const hasPermission = user.roles.some((userRole) => {
      if (allowedSet.has(userRole)) return true;
      const userEquivalents = ROLE_EQUIVALENCES[userRole];
      if (userEquivalents) {
        return userEquivalents.some((eq) => allowedSet.has(eq));
      }
      return false;
    });

    if (!hasPermission) {
      throw new ForbiddenException(
        `Acceso denegado: Se requiere uno de los roles: [${requiredRoles.join(", ")}]`,
      );
    }

    return true;
  }
}
