import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { STUDENT_REPOSITORY } from "./domain/student.repository";
import { InMemoryStudentRepository } from "./infrastructure/in-memory-student.repository";
import { StudentsController } from "./students.controller";
import { StudentsService } from "./students.service";

@Module({
  imports: [AuditModule],
  controllers: [StudentsController],
  providers: [
    // TEMPORAL en memoria: reemplazar por el adaptador PostgreSQL
    { provide: STUDENT_REPOSITORY, useClass: InMemoryStudentRepository },
    StudentsService,
  ],
  exports: [StudentsService],
})
export class StudentsModule {}
