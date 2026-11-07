import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HashService } from "@common/crypto/hash.service";
import { LoginDto } from "./dto/login.dto";
import * as crypto from "crypto";

@Injectable()
export class AuthService {
  constructor(
    private readonly configService: ConfigService,
    private readonly hashService: HashService,
  ) {}

  /**
   * Autenticación inicial de credenciales (Email + Password)
   */
  async login(loginDto: LoginDto) {
    const { email, password } = loginDto;

    if (!email || !password) {
      throw new UnauthorizedException("Credenciales inválidas.");
    }

    const mockUserId = "018e38d9-3f00-7200-a000-000000000001";
    const mockRoles = ["COORDINADORA_CONVIVENCIA", "super_admin"];

    // Token simulado seguro con HMAC para el andamiaje transversal
    const jwtSecret = this.configService.get<string>("JWT_SECRET", "secret");
    const tokenHeader = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url");
    const tokenPayload = Buffer.from(
      JSON.stringify({
        sub: mockUserId,
        email,
        roles: mockRoles,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
    ).toString("base64url");
    const signature = crypto
      .createHmac("sha256", jwtSecret)
      .update(`${tokenHeader}.${tokenPayload}`)
      .digest("base64url");
    const accessToken = `${tokenHeader}.${tokenPayload}.${signature}`;

    return {
      accessToken,
      refreshToken: crypto.randomBytes(32).toString("hex"),
      user: {
        id: mockUserId,
        email,
        roles: mockRoles,
        requiresMfa: true,
      },
    };
  }

  async verifyMfa(userId: string, code: string) {
    if (!code || code.length !== 6) {
      throw new UnauthorizedException("Código TOTP de 6 dígitos inválido.");
    }

    return {
      userId,
      mfaVerified: true,
      timestamp: new Date().toISOString(),
    };
  }
}
