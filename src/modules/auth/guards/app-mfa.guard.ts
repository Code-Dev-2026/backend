import { ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC_KEY } from "@common/decorators/public.decorator";
import { MfaGuard } from "@common/guards/mfa.guard";

/**
 * MfaGuard de @common adaptado para uso global: omite rutas @Public()
 * (login, refresh, mfa/verify) y contextos que no son HTTP.
 * La regla de MFA en sí sigue siendo la de @common/guards/mfa.guard.
 */
@Injectable()
export class AppMfaGuard extends MfaGuard {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== "http") {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    return super.canActivate(context);
  }
}
