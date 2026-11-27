import {
  MAX_TELEMETRY_PAYLOAD_BYTES,
  TelemetryPacketValidator,
} from "./telemetry-packet.validator";

describe("TelemetryPacketValidator (Issue #12)", () => {
  const fixedNow = new Date("2026-11-27T14:00:00.000Z");
  let validator: TelemetryPacketValidator;

  beforeEach(() => {
    validator = new TelemetryPacketValidator(undefined, () => fixedNow);
  });

  it("valida paquete JSON Buffer válido proveniente de MQTT para vehículo WKK123", () => {
    const payload = Buffer.from(
      JSON.stringify({
        lat: 4.8133,
        lon: -75.6961,
        velocidad: 38.5,
        precision: 9.2,
        rumbo: 180,
        odometro: 145210.7,
        timestamp: "2026-11-27T13:59:58.000Z",
      }),
      "utf8",
    );

    const outcome = validator.validate({
      source: "MQTT",
      topic: "telemetry/vehicles/WKK123/gps",
      vehicleIdentifier: "WKK123",
      receivedAtMs: fixedNow.getTime(),
      payload,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.packet.placa).toBe("WKK123");
      expect(outcome.packet.latitud).toBe(4.8133);
      expect(outcome.packet.longitud).toBe(-75.6961);
      expect(outcome.packet.velocidad_kmh).toBe(38.5);
      expect(outcome.packet.precision_metros).toBe(9.2);
      expect(outcome.packet.rumbo_grados).toBe(180);
      expect(outcome.packet.odometro_km).toBe(145210.7);
      expect(outcome.packet.precision_hdop).toBe(1.84);
    }
  });

  it("acepta precisión en el límite exacto de 30 m y descarta > 30 m", () => {
    const atLimit = validator.validate({
      source: "MQTT",
      topic: "telemetry/vehicles/WKK123/gps",
      receivedAtMs: fixedNow.getTime(),
      payload: {
        latitud: 4.81,
        longitud: -75.69,
        velocidad_kmh: 20,
        precision_metros: 30,
        rumbo_grados: 360,
        odometro_km: 1000,
        timestamp: "2026-11-27T13:59:59.000Z",
      },
    });

    expect(atLimit.ok).toBe(true);
    if (atLimit.ok) {
      expect(atLimit.packet.rumbo_grados).toBe(0);
    }

    const overLimit = validator.validate({
      source: "MQTT",
      topic: "telemetry/vehicles/WKK123/gps",
      receivedAtMs: fixedNow.getTime(),
      payload: {
        latitud: 4.81,
        longitud: -75.69,
        velocidad_kmh: 20,
        precision_metros: 30.01,
        rumbo_grados: 90,
        odometro_km: 1000,
        timestamp: "2026-11-27T13:59:59.000Z",
      },
    });

    expect(overLimit.ok).toBe(false);
    if (!overLimit.ok) {
      expect(overLimit.reason).toBe("LOW_GPS_ACCURACY");
      expect(overLimit.discardSilently).toBe(true);
    }
  });

  it("rechaza JSON malformado, payload no objeto y payload sobredimensionado", () => {
    const broken = validator.validate({
      source: "MQTT",
      topic: "telemetry/vehicles/WKK123/gps",
      receivedAtMs: fixedNow.getTime(),
      payload: Buffer.from("{bad json", "utf8"),
    });
    expect(broken.ok).toBe(false);
    if (!broken.ok) {
      expect(broken.reason).toBe("MALFORMED_JSON");
    }

    const arrayJson = validator.validate({
      source: "MQTT",
      topic: "telemetry/vehicles/WKK123/gps",
      receivedAtMs: fixedNow.getTime(),
      payload: Buffer.from("[1,2,3]", "utf8"),
    });
    expect(arrayJson.ok).toBe(false);
    if (!arrayJson.ok) {
      expect(arrayJson.reason).toBe("MALFORMED_JSON");
    }

    const huge = validator.validate({
      source: "MQTT",
      topic: "telemetry/vehicles/WKK123/gps",
      receivedAtMs: fixedNow.getTime(),
      payload: Buffer.alloc(MAX_TELEMETRY_PAYLOAD_BYTES + 1, "a"),
    });
    expect(huge.ok).toBe(false);
    if (!huge.ok) {
      expect(huge.reason).toBe("PAYLOAD_TOO_LARGE");
    }
  });

  it("bloquea suplantación de vehículo entre tópico MQTT y payload (OWASP ASVS V10.3)", () => {
    const spoofed = validator.validate({
      source: "MQTT",
      topic: "telemetry/vehicles/WKK123/gps",
      receivedAtMs: fixedNow.getTime(),
      payload: {
        placa: "SPOOF99",
        latitud: 4.81,
        longitud: -75.69,
        velocidad_kmh: 35,
        precision_metros: 8,
        rumbo_grados: 45,
        odometro_km: 500,
        timestamp: "2026-11-27T13:59:59.000Z",
      },
    });

    expect(spoofed.ok).toBe(false);
    if (!spoofed.ok) {
      expect(spoofed.reason).toBe("TOPIC_VEHICLE_MISMATCH");
    }
  });

  it("rechaza coordenadas fuera de rango, timestamps inválidos y timestamps futuros", () => {
    const badCoord = validator.validate({
      source: "HTTP_FALLBACK",
      receivedAtMs: fixedNow.getTime(),
      payload: {
        placa: "WKK123",
        latitud: 95,
        longitud: -75.69,
        velocidad_kmh: 25,
        precision_metros: 10,
        rumbo_grados: 45,
        odometro_km: 100,
        timestamp: "2026-11-27T13:59:59.000Z",
      },
    });
    expect(badCoord.ok).toBe(false);
    if (!badCoord.ok) {
      expect(badCoord.reason).toBe("INVALID_SCHEMA");
    }

    const futureTs = validator.validate({
      source: "HTTP_FALLBACK",
      receivedAtMs: fixedNow.getTime(),
      payload: {
        placa: "WKK123",
        latitud: 4.81,
        longitud: -75.69,
        velocidad_kmh: 25,
        precision_metros: 10,
        rumbo_grados: 45,
        odometro_km: 100,
        timestamp: "2026-11-27T14:10:00.000Z",
      },
    });
    expect(futureTs.ok).toBe(false);
    if (!futureTs.ok) {
      expect(futureTs.reason).toBe("FUTURE_TIMESTAMP");
    }

    const badTs = validator.validate({
      source: "HTTP_FALLBACK",
      receivedAtMs: fixedNow.getTime(),
      payload: {
        placa: "WKK123",
        latitud: 4.81,
        longitud: -75.69,
        velocidad_kmh: 25,
        precision_metros: 10,
        rumbo_grados: 45,
        odometro_km: 100,
        timestamp: "fecha-no-valida",
      },
    });
    expect(badTs.ok).toBe(false);
    if (!badTs.ok) {
      expect(badTs.reason).toBe("INVALID_TIMESTAMP");
    }
  });
});
