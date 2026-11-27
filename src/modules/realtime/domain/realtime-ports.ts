import { GuardianStudentLink, TripStudentCustody } from "./realtime.types";

export const GUARDIAN_LINK_REPOSITORY = Symbol("GUARDIAN_LINK_REPOSITORY");
export const TRIP_CUSTODY_READER = Symbol("TRIP_CUSTODY_READER");
export const REALTIME_CLOCK = Symbol("REALTIME_CLOCK");

export type RealtimeClock = () => number;

/**
 * Puerto de parentesco familiar (DIP — Issue #14).
 * PostgreSQL: `acudiente` ⋈ `estudiante_acudiente` ⋈ `usuario` (estado `ACTIVO`).
 */
export interface IGuardianLinkRepository {
  listGuardianLinksForStudents(
    idEstudiantes: readonly string[],
  ): Promise<GuardianStudentLink[]>;
}

/**
 * Lectura del estado de custodia de los estudiantes del viaje (`viaje_estudiante`).
 * Lo implementa `CustodyService.listTripCustody` (Issue #7), la misma fuente que
 * actualizan el abordaje (#8) y el desembarque (#9).
 */
export interface ITripCustodyReader {
  listTripCustody(idViaje: string): Promise<readonly TripStudentCustody[]>;
}
