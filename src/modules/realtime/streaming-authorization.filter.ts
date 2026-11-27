import { Inject, Injectable } from "@nestjs/common";
import { STREAMING_ENABLED_CUSTODY_STATE } from "./domain/realtime.constants";
import {
  GUARDIAN_LINK_REPOSITORY,
  IGuardianLinkRepository,
  ITripCustodyReader,
  TRIP_CUSTODY_READER,
} from "./domain/realtime-ports";
import {
  StreamDecision,
  StreamingPrincipal,
  TripGuardianAudience,
  TripStudentCustody,
} from "./domain/realtime.types";

const STAFF_DECISION: StreamDecision = {
  allowed: true,
  reason: "PERSONAL_AUTORIZADO",
  estudiantes: [],
};

/**
 * Filtro de autorización del stream telemático (SRP — Issue #14, RF-10, RNF-02).
 *
 * Determina qué clientes pueden recibir cada frame GPS:
 * - Personal operativo/institucional: siempre.
 * - Acudiente: solo si al menos uno de SUS hijos inscritos en el viaje está
 *   `A_BORDO_VEHICULO` en el momento de la difusión. El estado se lee sin caché
 *   de la fuente transaccional (`viaje_estudiante`), por lo que el desembarque
 *   confirmado corta el siguiente frame.
 */
@Injectable()
export class StreamingAuthorizationFilter {
  constructor(
    @Inject(TRIP_CUSTODY_READER)
    private readonly custodyReader: ITripCustodyReader,
    @Inject(GUARDIAN_LINK_REPOSITORY)
    private readonly guardianLinks: IGuardianLinkRepository,
  ) {}

  /** Una sola lectura de custodia + parentesco por viaje y frame, compartida por todos sus sockets. */
  async resolveTripAudience(idViaje: string): Promise<TripGuardianAudience> {
    const custody = await this.custodyReader.listTripCustody(idViaje);
    if (custody.length === 0) {
      return new Map();
    }

    const stateByStudent = new Map<string, string>(
      custody.map((c) => [c.id_estudiante, c.estado_custodia]),
    );
    const links = await this.guardianLinks.listGuardianLinksForStudents(
      Array.from(stateByStudent.keys()),
    );

    const audience = new Map<string, TripStudentCustody[]>();
    for (const link of links) {
      const estado = stateByStudent.get(link.id_estudiante);
      if (estado === undefined) {
        continue;
      }
      const children = audience.get(link.id_usuario) ?? [];
      if (!children.some((c) => c.id_estudiante === link.id_estudiante)) {
        children.push({
          id_estudiante: link.id_estudiante,
          estado_custodia: estado,
        });
      }
      audience.set(link.id_usuario, children);
    }
    return audience;
  }

  decide(
    principal: StreamingPrincipal,
    audience: TripGuardianAudience,
  ): StreamDecision {
    if (principal.kind === "STAFF") {
      return STAFF_DECISION;
    }

    const children = audience.get(principal.id_usuario);
    if (!children || children.length === 0) {
      return {
        allowed: false,
        reason: "SIN_VINCULO_CON_VIAJE",
        estudiantes: [],
      };
    }

    const onBoard = children.some(
      (c) => c.estado_custodia === STREAMING_ENABLED_CUSTODY_STATE,
    );
    return {
      allowed: onBoard,
      reason: onBoard ? "ESTUDIANTE_A_BORDO" : "SIN_ESTUDIANTE_A_BORDO",
      estudiantes: children.map((c) => ({ ...c })),
    };
  }

  async decideForTrip(
    principal: StreamingPrincipal,
    idViaje: string,
  ): Promise<StreamDecision> {
    if (principal.kind === "STAFF") {
      return STAFF_DECISION;
    }
    return this.decide(principal, await this.resolveTripAudience(idViaje));
  }
}
