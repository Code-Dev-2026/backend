import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  RawTelemetryEnvelope,
  TelemetryRejectionReason,
  ValidatedTelemetryPacket,
} from "./domain/telemetry.types";

export const TELEMETRY_CLOCK = Symbol("TELEMETRY_CLOCK");

export const MAX_TELEMETRY_PAYLOAD_BYTES = 8192;
export const DEFAULT_MAX_GPS_ACCURACY_METERS = 30;
export const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

const PLATE_REGEX = /^[A-Z0-9_-]{3,16}$/;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MQTT_TOPIC_REGEX = /^telemetry\/vehicles\/([A-Za-z0-9_-]{3,16})\/gps$/;

export type TelemetryValidationOutcome =
  | {
      readonly ok: true;
      readonly packet: ValidatedTelemetryPacket;
    }
  | {
      readonly ok: false;
      readonly reason: TelemetryRejectionReason;
      readonly details: string;
      readonly discardSilently: boolean;
    };

@Injectable()
export class TelemetryPacketValidator {
  private readonly maxAccuracyMeters: number;

  constructor(
    @Optional() configService?: ConfigService,
    @Optional()
    @Inject(TELEMETRY_CLOCK)
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.maxAccuracyMeters = Number(
      configService?.get<number>("TELEMETRY_MAX_ACCURACY_METERS") ??
        DEFAULT_MAX_GPS_ACCURACY_METERS,
    );
  }

  getMaxAccuracyMeters(): number {
    return this.maxAccuracyMeters;
  }

  extractVehicleFromTopic(topic: string): string | null {
    const match = MQTT_TOPIC_REGEX.exec(topic.trim());
    return match ? match[1].toUpperCase() : null;
  }

  validate(envelope: RawTelemetryEnvelope): TelemetryValidationOutcome {
    const parsed = this.parsePayload(envelope.payload);
    if (!parsed.ok) {
      return parsed;
    }

    const data = parsed.record;

    // 1. Identidad vehicular y coherencia con tópico MQTT (OWASP ASVS V10.3)
    const topicVehicle = envelope.topic
      ? this.extractVehicleFromTopic(envelope.topic)
      : envelope.vehicleIdentifier
        ? envelope.vehicleIdentifier.trim().toUpperCase()
        : null;

    if (envelope.source === "MQTT" && !topicVehicle) {
      return this.reject(
        "INVALID_SCHEMA",
        "Tópico MQTT inválido; se esperaba telemetry/vehicles/<placa>/gps.",
      );
    }

    const rawPlaca = this.readOptionalString(data, ["placa", "vehicle_plate"]);
    const normalizedPlaca = rawPlaca ? rawPlaca.trim().toUpperCase() : undefined;

    if (normalizedPlaca !== undefined && !PLATE_REGEX.test(normalizedPlaca)) {
      return this.reject(
        "INVALID_SCHEMA",
        "Formato de placa vehicular inválido.",
      );
    }

    if (
      topicVehicle &&
      normalizedPlaca &&
      topicVehicle !== normalizedPlaca
    ) {
      return this.reject(
        "TOPIC_VEHICLE_MISMATCH",
        `La placa del payload (${normalizedPlaca}) no coincide con el vehículo autenticado del tópico (${topicVehicle}).`,
      );
    }

    const idVehiculo = this.readOptionalString(data, ["id_vehiculo"]);
    if (idVehiculo !== undefined && !UUID_REGEX.test(idVehiculo)) {
      return this.reject(
        "INVALID_SCHEMA",
        "id_vehiculo debe ser un UUID válido.",
      );
    }

    const effectivePlaca = normalizedPlaca ?? topicVehicle ?? undefined;
    if (!effectivePlaca && !idVehiculo) {
      return this.reject(
        "INVALID_SCHEMA",
        "El paquete debe incluir placa o id_vehiculo.",
      );
    }

    const idViaje = this.readOptionalString(data, ["id_viaje"]);
    if (idViaje !== undefined && !UUID_REGEX.test(idViaje)) {
      return this.reject(
        "INVALID_SCHEMA",
        "id_viaje debe ser un UUID válido.",
      );
    }

    // 2. Coordenadas geográficas WGS84
    const latitud = this.readFiniteNumber(data, ["latitud", "lat"]);
    if (latitud === null || latitud < -90 || latitud > 90) {
      return this.reject(
        "INVALID_SCHEMA",
        "latitud/lat debe ser un número finito en el rango [-90, 90].",
      );
    }

    const longitud = this.readFiniteNumber(data, ["longitud", "lon", "lng"]);
    if (longitud === null || longitud < -180 || longitud > 180) {
      return this.reject(
        "INVALID_SCHEMA",
        "longitud/lon debe ser un número finito en el rango [-180, 180].",
      );
    }

    // 3. Cinemática vehicular (velocidad, rumbo, odómetro)
    const velocidad = this.readFiniteNumber(data, [
      "velocidad_kmh",
      "velocidad",
      "speed_kmh",
    ]);
    if (velocidad === null || velocidad < 0 || velocidad > 250) {
      return this.reject(
        "INVALID_SCHEMA",
        "velocidad_kmh debe ser un número finito en el rango [0, 250].",
      );
    }

    const rawRumbo = this.readFiniteNumber(data, [
      "rumbo_grados",
      "rumbo",
      "heading",
    ]);
    if (rawRumbo === null || rawRumbo < 0 || rawRumbo > 360) {
      return this.reject(
        "INVALID_SCHEMA",
        "rumbo_grados debe ser un número finito en el rango [0, 360].",
      );
    }
    const rumbo = rawRumbo === 360 ? 0 : rawRumbo;

    const odometro = this.readFiniteNumber(data, [
      "odometro_km",
      "odometro",
      "odometer_km",
    ]);
    if (odometro === null || odometro < 0) {
      return this.reject(
        "INVALID_SCHEMA",
        "odometro_km debe ser un número finito >= 0.",
      );
    }

    // 4. Precisión GPS y descarte obligatorio > 30 m (Issue #12)
    const precisionMetros = this.readFiniteNumber(data, [
      "precision_metros",
      "precision",
      "accuracy_m",
    ]);
    if (precisionMetros === null || precisionMetros < 0) {
      return this.reject(
        "INVALID_SCHEMA",
        "precision_metros debe ser un número finito >= 0.",
      );
    }

    if (precisionMetros > this.maxAccuracyMeters) {
      return {
        ok: false,
        reason: "LOW_GPS_ACCURACY",
        details: `Lectura GPS descartada por baja precisión (${precisionMetros} m > ${this.maxAccuracyMeters} m).`,
        discardSilently: true,
      };
    }

    const rawHdop = this.readFiniteNumber(data, ["precision_hdop", "hdop"]);
    if (
      this.hasAnyKey(data, ["precision_hdop", "hdop"]) &&
      (rawHdop === null || rawHdop < 0 || rawHdop > 99.99)
    ) {
      return this.reject(
        "INVALID_SCHEMA",
        "precision_hdop debe estar en el rango [0, 99.99].",
      );
    }
    const precisionHdop =
      rawHdop ?? Math.min(99.99, Number((precisionMetros / 5).toFixed(2)));

    // 5. Batería de respaldo opcional
    const rawBattery = data["bateria_respaldo_activa"];
    if (rawBattery !== undefined && typeof rawBattery !== "boolean") {
      return this.reject(
        "INVALID_SCHEMA",
        "bateria_respaldo_activa debe ser booleano.",
      );
    }
    const bateriaRespaldoActiva = rawBattery === true;

    // 6. Marca temporal UTC
    const rawTimestamp = this.readOptionalString(data, [
      "timestamp",
      "fecha_hora",
    ]);
    if (!rawTimestamp) {
      return this.reject(
        "INVALID_TIMESTAMP",
        "timestamp/fecha_hora es obligatorio en formato ISO-8601.",
      );
    }

    const fechaHora = new Date(rawTimestamp);
    if (Number.isNaN(fechaHora.getTime())) {
      return this.reject(
        "INVALID_TIMESTAMP",
        "timestamp/fecha_hora no es una fecha ISO-8601 válida.",
      );
    }

    const nowMs = this.clock().getTime();
    if (fechaHora.getTime() > nowMs + MAX_FUTURE_CLOCK_SKEW_MS) {
      return this.reject(
        "FUTURE_TIMESTAMP",
        "timestamp excede el desfase máximo permitido hacia el futuro (5 minutos).",
      );
    }

    return {
      ok: true,
      packet: {
        id_vehiculo: idVehiculo,
        placa: effectivePlaca,
        id_viaje: idViaje,
        latitud,
        longitud,
        velocidad_kmh: Number(velocidad.toFixed(2)),
        rumbo_grados: Number(rumbo.toFixed(2)),
        precision_metros: Number(precisionMetros.toFixed(2)),
        precision_hdop: Number(precisionHdop.toFixed(2)),
        odometro_km: Number(odometro.toFixed(2)),
        bateria_respaldo_activa: bateriaRespaldoActiva,
        fecha_hora: fechaHora,
        source: envelope.source,
      },
    };
  }

  private parsePayload(
    payload: unknown,
  ):
    | { ok: true; record: Record<string, unknown> }
    | {
        ok: false;
        reason: TelemetryRejectionReason;
        details: string;
        discardSilently: boolean;
      } {
    if (Buffer.isBuffer(payload)) {
      if (payload.byteLength === 0 || payload.byteLength > MAX_TELEMETRY_PAYLOAD_BYTES) {
        return this.reject(
          "PAYLOAD_TOO_LARGE",
          `Tamaño de paquete fuera de rango (1..${MAX_TELEMETRY_PAYLOAD_BYTES} bytes).`,
        );
      }
      return this.parseJsonString(payload.toString("utf8"));
    }

    if (typeof payload === "string") {
      const byteLength = Buffer.byteLength(payload, "utf8");
      if (byteLength === 0 || byteLength > MAX_TELEMETRY_PAYLOAD_BYTES) {
        return this.reject(
          "PAYLOAD_TOO_LARGE",
          `Tamaño de paquete fuera de rango (1..${MAX_TELEMETRY_PAYLOAD_BYTES} bytes).`,
        );
      }
      return this.parseJsonString(payload);
    }

    if (this.isPlainRecord(payload)) {
      return { ok: true, record: payload };
    }

    return this.reject(
      "MALFORMED_JSON",
      "El paquete telemático debe ser un objeto JSON válido.",
    );
  }

  private parseJsonString(
    raw: string,
  ):
    | { ok: true; record: Record<string, unknown> }
    | {
        ok: false;
        reason: TelemetryRejectionReason;
        details: string;
        discardSilently: boolean;
      } {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!this.isPlainRecord(parsed)) {
        return this.reject(
          "MALFORMED_JSON",
          "El payload JSON debe corresponder a un objeto clave-valor.",
        );
      }
      return { ok: true, record: parsed };
    } catch {
      return this.reject(
        "MALFORMED_JSON",
        "No fue posible decodificar el mensaje JSON telemático.",
      );
    }
  }

  private isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private hasAnyKey(
    record: Record<string, unknown>,
    keys: readonly string[],
  ): boolean {
    return keys.some((key) => record[key] !== undefined);
  }

  private readFiniteNumber(
    record: Record<string, unknown>,
    keys: readonly string[],
  ): number | null {
    for (const key of keys) {
      const value = record[key];
      if (value !== undefined) {
        if (typeof value === "number" && Number.isFinite(value)) {
          return value;
        }
        return null;
      }
    }
    return null;
  }

  private readOptionalString(
    record: Record<string, unknown>,
    keys: readonly string[],
  ): string | undefined {
    for (const key of keys) {
      const value = record[key];
      if (value !== undefined) {
        return typeof value === "string" && value.trim().length > 0
          ? value.trim()
          : "";
      }
    }
    return undefined;
  }

  private reject(
    reason: TelemetryRejectionReason,
    details: string,
  ): {
    ok: false;
    reason: TelemetryRejectionReason;
    details: string;
    discardSilently: boolean;
  } {
    return { ok: false, reason, details, discardSilently: false };
  }
}
