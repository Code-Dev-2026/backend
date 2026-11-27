import { Injectable } from "@nestjs/common";
import { IGuardianLinkRepository } from "../domain/realtime-ports";
import { GuardianStudentLink } from "../domain/realtime.types";

/**
 * Adaptador en memoria del parentesco familiar (modo por defecto, `REALTIME_USE_POSTGRES != true`).
 * Replica `acudiente.id_usuario` ⋈ `estudiante_acudiente` para pruebas y desarrollo local.
 */
@Injectable()
export class InMemoryGuardianLinkRepository implements IGuardianLinkRepository {
  private readonly links: GuardianStudentLink[] = [];

  registerLink(link: GuardianStudentLink): void {
    this.removeLink(link.id_usuario, link.id_estudiante);
    this.links.push({ ...link });
  }

  removeLink(idUsuario: string, idEstudiante: string): void {
    for (let i = this.links.length - 1; i >= 0; i--) {
      const l = this.links[i];
      if (l.id_usuario === idUsuario && l.id_estudiante === idEstudiante) {
        this.links.splice(i, 1);
      }
    }
  }

  async listGuardianIdsForUser(idUsuario: string): Promise<string[]> {
    return Array.from(
      new Set(
        this.links
          .filter((l) => l.id_usuario === idUsuario)
          .map((l) => l.id_acudiente),
      ),
    );
  }

  async listGuardianLinksForStudents(
    idEstudiantes: readonly string[],
  ): Promise<GuardianStudentLink[]> {
    const wanted = new Set(idEstudiantes);
    return this.links
      .filter((l) => wanted.has(l.id_estudiante))
      .map((l) => ({ ...l }));
  }
}
