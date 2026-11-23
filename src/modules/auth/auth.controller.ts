import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Public } from "@common/decorators/public.decorator";
import { LoginDto } from "./dto/login.dto";
import { RefreshTokenDto } from "./dto/refresh-token.dto";
import { VerifyOtpDto } from "./dto/verify-otp.dto";
import { AuthSession } from "./session.service";
import { LoginResult, LoginUseCase } from "./use-cases/login.use-case";
import {
  RefreshResult,
  RefreshSessionUseCase,
} from "./use-cases/refresh-session.use-case";
import { VerifyOtpUseCase } from "./use-cases/verify-otp.use-case";

/**
 * Endpoints de identidad. Son @Public porque ellos mismos validan
 * credenciales, refresh token o token provisional + OTP.
 */
@ApiTags("Auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly loginUseCase: LoginUseCase,
    private readonly verifyOtpUseCase: VerifyOtpUseCase,
    private readonly refreshSessionUseCase: RefreshSessionUseCase,
  ) {}

  @Public()
  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Paso 1: valida correo y contraseña y envía un código OTP de 6 dígitos al correo.",
  })
  login(@Body() dto: LoginDto): Promise<LoginResult> {
    return this.loginUseCase.execute(dto);
  }

  @Public()
  @Post("verify-otp")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Paso 2: valida el código OTP y entrega Access Token (15 min) y Refresh Token (7 días).",
  })
  verifyOtp(@Body() dto: VerifyOtpDto): Promise<AuthSession> {
    return this.verifyOtpUseCase.execute(dto.mfaToken, dto.code);
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
}
