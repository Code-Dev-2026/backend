import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { AuthenticatedUser } from "../decorators/current-user.decorator";
import { RoleEnum } from "../enums/role.enum";

@Injectable()
export class MfaGuard implements CanActivate {
  private readonly mfaMandatoryRoles = [
    RoleEnum.COORDINADORA_CONVIVENCIA,
    RoleEnum.RECTORIA,
    RoleEnum.SUPER_ADMIN,
    RoleEnum.SCHOOL_COORDINATOR,
  ];

  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest() as {
      user?: AuthenticatedUser;
    };

    if (!user) {
      throw new UnauthorizedException("Usuario no autenticado.");
    }

    const requiresMfa = user.roles?.some((r) =>
      this.mfaMandatoryRoles.includes(r as RoleEnum),
    );

    if (requiresMfa && !user.mfa_autenticado) {
      throw new UnauthorizedException(
        "Operación bloqueada: Requiere validación de Segundo Factor de Autenticación (MFA/TOTP).",
      );
    }

    return true;
  }
}
