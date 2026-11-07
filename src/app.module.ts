import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { envValidationSchema } from "@config/env.validation";

// Módulo Transversal Criptográfico (ADR-002)
import { CryptoModule } from "@common/crypto/crypto.module";

// Módulos de Dominio (Sprints 1 al 4)
import { AuthModule } from "./modules/auth/auth.module";
import { StudentsModule } from "./modules/students/students.module";
import { SchoolsModule } from "./modules/schools/schools.module";
import { TransportCompaniesModule } from "./modules/transport-companies/transport-companies.module";
import { RoutesModule } from "./modules/routes/routes.module";
import { TripsModule } from "./modules/trips/trips.module";
import { CustodyModule } from "./modules/custody/custody.module";
import { AttendanceModule } from "./modules/attendance/attendance.module";
import { PassengersModule } from "./modules/passengers/passengers.module";
import { TelemetryModule } from "./modules/telemetry/telemetry.module";
import { TrackingModule } from "./modules/tracking/tracking.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { OfflineModule } from "./modules/offline/offline.module";
import { AuditModule } from "./modules/audit/audit.module";
import { BillingIsolationModule } from "./modules/billing-isolation/billing-isolation.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
      validationOptions: {
        abortEarly: false,
      },
    }),
    CryptoModule,
    // Sprint 1
    AuthModule,
    StudentsModule,
    SchoolsModule,
    TransportCompaniesModule,
    // Sprint 2
    RoutesModule,
    TripsModule,
    CustodyModule,
    AttendanceModule,
    // Sprint 3
    PassengersModule,
    TelemetryModule,
    TrackingModule,
    NotificationsModule,
    // Sprint 4
    OfflineModule,
    AuditModule,
    BillingIsolationModule,
  ],
})
export class AppModule {}
