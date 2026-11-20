import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Public } from "@common/decorators/public.decorator";
import { LoginDto } from "./dto/login.dto";
import { MfaVerifyDto } from "./dto/mfa-verify.dto";
import { RefreshTokenDto } from "./dto/refresh-token.dto";
import { LoginResult, LoginUseCase } from "./use-cases/login.use-case";
import {
  RefreshResult,
  RefreshSessionUseCase,
} from "./use-cases/refresh-session.use-case";
import { VerifyMfaUseCase } from "./use-cases/verify-mfa.use-case";
import { AuthSession } from "./session.service";

/**
 * Endpoints de identidad. Son @Public porque ellos mismos validan
 * credenciales, refresh token o token provisional MFA.
 */
@ApiTags("Auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly loginUseCase: LoginUseCase,
    private readonly verifyMfaUseCase: VerifyMfaUseCase,
    private readonly refreshSessionUseCase: RefreshSessionUseCase,
  ) {}

  @Public()
  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Iniciar sesión. Roles con MFA reciben un token provisional y un desafío OTP.",
  })
  login(@Body() dto: LoginDto): Promise<LoginResult> {
    return this.loginUseCase.execute(dto);
  }

  @Public()
  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Renovar la sesión (rotación del refresh token).",
  })
  refresh(@Body() dto: RefreshTokenDto): Promise<RefreshResult> {
    return this.refreshSessionUseCase.execute(dto.refreshToken);
  }

  @Public()
  @Post("mfa/verify")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Completar el desafío MFA con el código OTP de 6 dígitos.",
  })
  verifyMfa(@Body() dto: MfaVerifyDto): Promise<AuthSession> {
    return this.verifyMfaUseCase.execute(dto.mfaToken, dto.code);
  }
}
