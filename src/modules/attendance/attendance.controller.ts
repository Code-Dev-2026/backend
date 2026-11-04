import { Controller, Post, Body, Param, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AttendanceService, BoardingScanDto } from './attendance.service';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { RoleEnum } from '@common/enums/role.enum';
import { ParseUUIDv7Pipe } from '@common/pipes/parse-uuidv7.pipe';

@ApiTags('Asistencia, Abordaje QR y Control de Aforo (Attendance & Capacity)')
@ApiBearerAuth('JWT')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  @Post('board')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleEnum.MONITOR, RoleEnum.MONITORA, RoleEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Registrar abordaje por escaneo de carné QR y validar cupo duro N+1 (RN-01, RN-02)' })
  async boardStudent(@Body() dto: BoardingScanDto) {
    return this.attendanceService.registerBoarding(dto);
  }

  @Post('alight/:viajeId/:estudianteId')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleEnum.MONITOR, RoleEnum.MONITORA, RoleEnum.SUPER_ADMIN)
  @ApiOperation({ summary: 'Registrar desembarque y entrega formal del estudiante' })
  async alightStudent(
    @Param('viajeId', ParseUUIDv7Pipe) viajeId: string,
    @Param('estudianteId', ParseUUIDv7Pipe) estudianteId: string,
  ) {
    return this.attendanceService.registerAlighting(viajeId, estudianteId);
  }
}
