import { Controller, Post, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { VerifyMfaDto } from './dto/verify-mfa.dto';
import { Public } from '@common/decorators/public.decorator';
import { CurrentUser, AuthenticatedUser } from '@common/decorators/current-user.decorator';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';

@ApiTags('Autenticación y Sesiones (Auth & RBAC)')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Iniciar sesión con credenciales institucionales y emisión de JWT' })
  @ApiResponse({ status: 200, description: 'Sesión iniciada con éxito' })
  @ApiResponse({ status: 401, description: 'Credenciales inválidas' })
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Renovar Access Token mediante Refresh Token' })
  @ApiResponse({ status: 200, description: 'Token renovado con éxito' })
  @ApiResponse({ status: 401, description: 'Refresh token revocado o expirado' })
  async refresh(@Body() refreshTokenDto: RefreshTokenDto) {
    return this.authService.refreshTokens(refreshTokenDto);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT')
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validar código TOTP de segundo factor (MFA) para roles directivos' })
  @ApiResponse({ status: 200, description: 'MFA validado exitosamente' })
  @ApiResponse({ status: 400, description: 'Código TOTP incorrecto o expirado' })
  async verifyMfa(
    @CurrentUser() user: AuthenticatedUser,
    @Body() verifyMfaDto: VerifyMfaDto,
  ) {
    return this.authService.verifyMfa(user, verifyMfaDto);
  }
}
