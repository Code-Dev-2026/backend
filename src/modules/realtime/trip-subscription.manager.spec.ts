import {
  GPS_EMIT_THROTTLE_MS,
  MAX_TRIP_SUBSCRIPTIONS_PER_SOCKET,
} from "./domain/realtime.constants";
import { StreamingPrincipal } from "./domain/realtime.types";
import {
  isValidTripId,
  TripSubscriptionManager,
} from "./trip-subscription.manager";

const TRIP = "018e38d9-3f00-7200-a000-00000000f100";
const principal: StreamingPrincipal = {
  id_usuario: "u-1",
  email: "u@test.co",
  roles: ["ACUDIENTE"],
  kind: "GUARDIAN",
  expiresAtMs: Number.POSITIVE_INFINITY,
};

describe("TripSubscriptionManager (Issue #14)", () => {
  let manager: TripSubscriptionManager;

  beforeEach(() => {
    manager = new TripSubscriptionManager();
    manager.registerSocket("s1", principal);
  });

  it("valida identificadores de viaje UUID", () => {
    expect(isValidTripId(TRIP)).toBe(true);
    expect(isValidTripId("V-100")).toBe(false);
    expect(isValidTripId(undefined)).toBe(false);
    expect(isValidTripId("' OR 1=1 --")).toBe(false);
  });

  it("throttle: máximo 1 frame cada 2 s por cliente, sin retrasar frames", () => {
    manager.addTrip("s1", TRIP, true);
    expect(manager.tryAcquireEmitSlot("s1", TRIP, 0)).toBe(true);
    expect(manager.tryAcquireEmitSlot("s1", TRIP, 500)).toBe(false);
    expect(
      manager.tryAcquireEmitSlot("s1", TRIP, GPS_EMIT_THROTTLE_MS - 1),
    ).toBe(false);
    expect(manager.tryAcquireEmitSlot("s1", TRIP, GPS_EMIT_THROTTLE_MS)).toBe(
      true,
    );
  });

  it("aplica el throttle de forma independiente por cliente", () => {
    manager.registerSocket("s2", principal);
    manager.addTrip("s1", TRIP, true);
    manager.addTrip("s2", TRIP, true);
    expect(manager.tryAcquireEmitSlot("s1", TRIP, 0)).toBe(true);
    expect(manager.tryAcquireEmitSlot("s2", TRIP, 100)).toBe(true);
  });

  it("limita las salas por socket", () => {
    for (let i = 0; i < MAX_TRIP_SUBSCRIPTIONS_PER_SOCKET; i++) {
      expect(manager.addTrip("s1", `trip-${i}`, true)).toBe("ADDED");
    }
    expect(manager.addTrip("s1", "trip-extra", true)).toBe("LIMIT_REACHED");
    expect(manager.addTrip("s1", "trip-0", false)).toBe("ALREADY_SUBSCRIBED");
  });

  it("informa solo los cambios de estado de transmisión", () => {
    manager.addTrip("s1", TRIP, true);
    expect(manager.updateTransmitting("s1", TRIP, true)).toBe(false);
    expect(manager.updateTransmitting("s1", TRIP, false)).toBe(true);
    expect(manager.updateTransmitting("s1", TRIP, false)).toBe(false);
  });

  it("libera el estado al desconectar", () => {
    manager.addTrip("s1", TRIP, true);
    manager.unregisterSocket("s1");
    expect(manager.getPrincipal("s1")).toBeNull();
    expect(manager.isSubscribed("s1", TRIP)).toBe(false);
    expect(manager.tryAcquireEmitSlot("s1", TRIP, 0)).toBe(false);
  });
});
