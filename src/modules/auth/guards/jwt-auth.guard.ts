import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthenticatedUser } from "@common/decorators/current-user.decorator";
import { IS_PUBLIC_KEY } from "@common/decorators/public.decorator";
import { TokenService } from "../token.service";

interface RequestWithUser {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
}

/**
 * Guard global de autenticación: exige un Access Token Bearer válido.
 * Las rutas marcadas con @Public() se omiten. Solo aplica a HTTP.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenService: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
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

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const header = request.headers["authorization"];
    const [scheme, token] = (typeof header === "string" ? header : "").split(
      " ",
    );

    if (scheme?.toLowerCase() !== "bearer" || !token) {
      throw new UnauthorizedException("Token de acceso requerido.");
    }

    request.user = await this.tokenService.verifyAccessToken(token);
    return true;
  }
}
