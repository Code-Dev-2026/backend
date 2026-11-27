import { ITripCustodyReader } from "./domain/realtime-ports";
import {
  StreamingPrincipal,
  TripStudentCustody,
} from "./domain/realtime.types";
import { InMemoryGuardianLinkRepository } from "./infrastructure/in-memory-guardian-link.repository";
import { StreamingAuthorizationFilter } from "./streaming-authorization.filter";

const TRIP = "018e38d9-3f00-7200-a000-00000000e100";
const CHILD_A = "018e38d9-3f00-7200-a000-00000000e201";
const CHILD_B = "018e38d9-3f00-7200-a000-00000000e202";
const CHILD_C = "018e38d9-3f00-7200-a000-00000000e203";
const USER_A = "018e38d9-3f00-7200-a000-00000000e301";
const USER_B = "018e38d9-3f00-7200-a000-00000000e302";
const USER_STRANGER = "018e38d9-3f00-7200-a000-00000000e399";

const principal = (
  id_usuario: string,
  kind: StreamingPrincipal["kind"] = "GUARDIAN",
): StreamingPrincipal => ({
  id_usuario,
  email: `${id_usuario}@test.co`,
  roles: [kind === "STAFF" ? "MONITORA" : "ACUDIENTE"],
  kind,
  expiresAtMs: Number.POSITIVE_INFINITY,
});

class StubCustodyReader implements ITripCustodyReader {
  states: TripStudentCustody[] = [];
  calls = 0;
  async listTripCustody(): Promise<readonly TripStudentCustody[]> {
    this.calls += 1;
    return this.states.map((s) => ({ ...s }));
  }
}

describe("StreamingAuthorizationFilter (Issue #14 — RF-10, RNF-02)", () => {
  let custody: StubCustodyReader;
  let links: InMemoryGuardianLinkRepository;
  let filter: StreamingAuthorizationFilter;

  beforeEach(() => {
    custody = new StubCustodyReader();
    links = new InMemoryGuardianLinkRepository();
    links.registerLink({
      id_usuario: USER_A,
      id_acudiente: "acu-a",
      id_estudiante: CHILD_A,
    });
    links.registerLink({
      id_usuario: USER_B,
      id_acudiente: "acu-b",
      id_estudiante: CHILD_B,
    });
    links.registerLink({
      id_usuario: USER_B,
      id_acudiente: "acu-b",
      id_estudiante: CHILD_C,
    });
    filter = new StreamingAuthorizationFilter(custody, links);
  });

  it("autoriza al personal sin consultar custodia", async () => {
    const decision = await filter.decideForTrip(
      principal(USER_STRANGER, "STAFF"),
      TRIP,
    );
    expect(decision).toEqual({
      allowed: true,
      reason: "PERSONAL_AUTORIZADO",
      estudiantes: [],
    });
    expect(custody.calls).toBe(0);
  });

  it("autoriza al acudiente mientras su hijo está A_BORDO_VEHICULO", async () => {
    custody.states = [
      { id_estudiante: CHILD_A, estado_custodia: "A_BORDO_VEHICULO" },
    ];
    const decision = await filter.decideForTrip(principal(USER_A), TRIP);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("ESTUDIANTE_A_BORDO");
  });

  it.each(["NO_INICIADO", "EN_ESPERA_ABORDAJE"])(
    "bloquea antes de que el hijo suba (%s)",
    async (estado) => {
      custody.states = [{ id_estudiante: CHILD_A, estado_custodia: estado }];
      const decision = await filter.decideForTrip(principal(USER_A), TRIP);
      expect(decision).toMatchObject({
        allowed: false,
        reason: "SIN_ESTUDIANTE_A_BORDO",
      });
    },
  );

  it.each([
    "ENTREGADO_ACUDIENTE",
    "EN_COLEGIO",
    "RETORNO_SEDE_POR_FALLA_ENTREGA",
  ])("bloquea después del desembarque (%s)", async (estado) => {
    custody.states = [{ id_estudiante: CHILD_A, estado_custodia: estado }];
    const decision = await filter.decideForTrip(principal(USER_A), TRIP);
    expect(decision).toMatchObject({
      allowed: false,
      reason: "SIN_ESTUDIANTE_A_BORDO",
    });
  });

  it("autoriza si al menos uno de varios hijos sigue a bordo", async () => {
    custody.states = [
      { id_estudiante: CHILD_B, estado_custodia: "ENTREGADO_ACUDIENTE" },
      { id_estudiante: CHILD_C, estado_custodia: "A_BORDO_VEHICULO" },
    ];
    const decision = await filter.decideForTrip(principal(USER_B), TRIP);
    expect(decision.allowed).toBe(true);
    expect(decision.estudiantes).toHaveLength(2);
  });

  it("niega a quien no tiene hijos inscritos en el viaje", async () => {
    custody.states = [
      { id_estudiante: CHILD_A, estado_custodia: "A_BORDO_VEHICULO" },
    ];
    await expect(
      filter.decideForTrip(principal(USER_STRANGER), TRIP),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "SIN_VINCULO_CON_VIAJE",
    });
    // El vínculo de B existe, pero sus hijos no están en este viaje.
    await expect(
      filter.decideForTrip(principal(USER_B), TRIP),
    ).resolves.toMatchObject({
      reason: "SIN_VINCULO_CON_VIAJE",
    });
  });

  it("aísla la información familiar: cada acudiente solo ve a sus hijos (RNF-02)", async () => {
    custody.states = [
      { id_estudiante: CHILD_A, estado_custodia: "A_BORDO_VEHICULO" },
      { id_estudiante: CHILD_B, estado_custodia: "A_BORDO_VEHICULO" },
    ];
    const audience = await filter.resolveTripAudience(TRIP);
    const decisionA = filter.decide(principal(USER_A), audience);
    const decisionB = filter.decide(principal(USER_B), audience);
    expect(decisionA.estudiantes.map((e) => e.id_estudiante)).toEqual([
      CHILD_A,
    ]);
    expect(decisionB.estudiantes.map((e) => e.id_estudiante)).toEqual([
      CHILD_B,
    ]);
  });

  it("lee el estado en cada evaluación (sin caché): el desembarque se refleja de inmediato", async () => {
    custody.states = [
      { id_estudiante: CHILD_A, estado_custodia: "A_BORDO_VEHICULO" },
    ];
    expect((await filter.decideForTrip(principal(USER_A), TRIP)).allowed).toBe(
      true,
    );
    custody.states = [
      { id_estudiante: CHILD_A, estado_custodia: "ENTREGADO_ACUDIENTE" },
    ];
    expect((await filter.decideForTrip(principal(USER_A), TRIP)).allowed).toBe(
      false,
    );
    expect(custody.calls).toBe(2);
  });

  it("devuelve audiencia vacía si el viaje no tiene estudiantes", async () => {
    await expect(filter.resolveTripAudience(TRIP)).resolves.toEqual(new Map());
  });
});
