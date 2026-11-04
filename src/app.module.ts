import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { envValidationSchema } from '@config/env.validation';
import { typeOrmAsyncConfig } from '@config/database.config';
import { CryptoModule } from '@common/crypto/crypto.module';

// Módulos de Dominio (Clean Architecture)
import { AuthModule } from '@modules/auth/auth.module';
import { SchoolsModule } from '@modules/schools/schools.module';
import { TransportCompaniesModule } from '@modules/transport-companies/transport-companies.module';
import { StudentsModule } from '@modules/students/students.module';
import { CustodyModule } from '@modules/custody/custody.module';
import { RoutesModule } from '@modules/routes/routes.module';
import { TripsModule } from '@modules/trips/trips.module';
import { AttendanceModule } from '@modules/attendance/attendance.module';
import { TelemetryModule } from '@modules/telemetry/telemetry.module';
import { TrackingModule } from '@modules/tracking/tracking.module';
import { NotificationsModule } from '@modules/notifications/notifications.module';
import { BillingIsolationModule } from '@modules/billing-isolation/billing-isolation.module';
import { AuditModule } from '@modules/audit/audit.module';

@Module({
  imports: [
    // 1. Configuración Global con validación estricta de variables de entorno (Joi)
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
      validationOptions: {
        abortEarly: false,
      },
    }),

    // 2. Persistencia Principal: PostgreSQL 16 + PostGIS 3.4
    TypeOrmModule.forRootAsync(typeOrmAsyncConfig),

    // 3. Módulo Criptográfico Global (AES-256-GCM, Blind Index HMAC-SHA256, Argon2id)
    CryptoModule,

    // 4. Módulos de Dominio
    AuthModule,
    SchoolsModule,
    TransportCompaniesModule,
    StudentsModule,
    CustodyModule,
    RoutesModule,
    TripsModule,
    AttendanceModule,
    TelemetryModule,
    TrackingModule,
    NotificationsModule,
    BillingIsolationModule,
    AuditModule,
  ],
})
export class AppModule {}
