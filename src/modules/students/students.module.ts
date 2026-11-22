import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { SchoolsModule } from "../schools/schools.module";
import { STUDENT_REPOSITORY } from "./domain/student.repository";
import { EnrollmentImportService } from "./import/enrollment-import.service";
import { IMPORT_LEDGER, InMemoryImportLedger } from "./import/import-ledger";
import { StudentsImportController } from "./import/students-import.controller";
import { InMemoryStudentRepository } from "./infrastructure/in-memory-student.repository";
import { StudentsController } from "./students.controller";
import { StudentsService } from "./students.service";

@Module({
  imports: [AuditModule, SchoolsModule],
  // El controlador de importación va primero: POST /students/import no debe
  // chocar con ninguna ruta parametrizada de /students.
  controllers: [StudentsImportController, StudentsController],
  providers: [
    // TEMPORALES en memoria: reemplazar por adaptadores PostgreSQL
    { provide: STUDENT_REPOSITORY, useClass: InMemoryStudentRepository },
    { provide: IMPORT_LEDGER, useClass: InMemoryImportLedger },
    StudentsService,
    EnrollmentImportService,
  ],
  exports: [StudentsService],
})
export class StudentsModule {}
