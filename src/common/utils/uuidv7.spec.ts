import { uuidv7 } from "./uuidv7";

describe("uuidv7", () => {
  const UUID_V7 =
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("genera un UUID con versión 7 y variante RFC 9562", () => {
    expect(uuidv7()).toMatch(UUID_V7);
  });

  it("codifica la marca de tiempo en los primeros 48 bits", () => {
    const now = Date.UTC(2026, 10, 22, 12, 0, 0);
    const id = uuidv7(now);
    const ts = parseInt(id.replace(/-/g, "").slice(0, 12), 16);

    expect(ts).toBe(now);
  });

  it("es ordenable por tiempo y no repite valores", () => {
    const a = uuidv7(1_000);
    const b = uuidv7(2_000);

    expect(a < b).toBe(true);
    expect(new Set(Array.from({ length: 500 }, () => uuidv7())).size).toBe(500);
  });
});
