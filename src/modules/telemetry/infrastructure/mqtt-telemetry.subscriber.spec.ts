import { EventEmitter } from "events";
import { ConfigService } from "@nestjs/config";
import { IClientOptions } from "mqtt";
import {
  formatGpsPartitionName,
  TELEMETRY_GPS_RECORDED_EVENT,
  TelemetryRecordedEventPayload,
} from "../domain/telemetry.types";
import { TelemetryPacketValidator } from "../telemetry-packet.validator";
import { TelemetryService } from "../telemetry.service";
import { InMemoryEventDispatcher } from "./in-memory-event-dispatcher";
import { InMemoryTelemetryRepository } from "./in-memory-telemetry.repository";
import {
  MqttClientLike,
  MqttTelemetrySubscriber,
} from "./mqtt-telemetry.subscriber";
import { TelemetryIngestChannel } from "./telemetry-ingest.channel";

class FakeMqttClient extends EventEmitter implements MqttClientLike {
  readonly subscribedTopics: Array<{ topic: string; qos: number }> = [];
  ended = false;

  subscribe(
    topic: string,
    opts: { qos: 0 | 1 | 2 },
    callback?: (err: Error | null) => void,
  ): void {
    this.subscribedTopics.push({ topic, qos: opts.qos });
    callback?.(null);
  }

  end(_force?: boolean, callback?: () => void): void {
    this.ended = true;
    callback?.();
  }
}

describe("MqttTelemetrySubscriber (Issue #12 — TLS/mTLS y Reconexión)", () => {
  const createConfig = (values: Record<string, unknown>) =>
    ({
      get: <T>(key: string, defaultValue?: T) =>
        (values[key] as T | undefined) ?? defaultValue,
    }) as unknown as ConfigService;

  it("se suscribe a telemetry/vehicles/+/gps, procesa mensajes JSON de WKK123 y sobrevive desconexión/reconexión automática", async () => {
    const ingestPort = new TelemetryIngestChannel();
    const repository = new InMemoryTelemetryRepository();
    const dispatcher = new InMemoryEventDispatcher();
    const validator = new TelemetryPacketValidator();
    const service = new TelemetryService(
      ingestPort,
      repository,
      dispatcher,
      validator,
      createConfig({ TELEMETRY_BATCH_SIZE: 1, TELEMETRY_BATCH_FLUSH_MS: 10 }),
    );

    const fakeClient = new FakeMqttClient();
    let capturedUrl = "";
    let capturedOptions: IClientOptions | undefined;

    const subscriber = new MqttTelemetrySubscriber(
      ingestPort,
      validator,
      createConfig({
        NODE_ENV: "development",
        MQTT_ENABLED: "true",
        MQTT_BROKER_URL: "mqtts://localhost:8883",
        MQTT_TOPIC_PATTERN: "telemetry/vehicles/+/gps",
        MQTT_USERNAME: "backend_telemetry",
        MQTT_PASSWORD: "dev-env-password",
        MQTT_RECONNECT_PERIOD_MS: 1000,
      }),
      (url, opts) => {
        capturedUrl = url;
        capturedOptions = opts;
        return fakeClient;
      },
    );

    const events: TelemetryRecordedEventPayload[] = [];
    dispatcher.subscribe<TelemetryRecordedEventPayload>(
      TELEMETRY_GPS_RECORDED_EVENT,
      async (evt) => {
        events.push(evt);
      },
    );

    try {
      subscriber.onModuleInit();
      expect(capturedUrl).toBe("mqtts://localhost:8883");
      expect(capturedOptions?.reconnectPeriod).toBe(1000);
      expect(capturedOptions?.rejectUnauthorized).toBe(true);
      expect(capturedOptions?.username).toBe("backend_telemetry");

      // 1. Conexión inicial
      fakeClient.emit("connect");
      expect(subscriber.getStatus().state).toBe("CONNECTED");
      expect(fakeClient.subscribedTopics).toHaveLength(1);
      expect(fakeClient.subscribedTopics[0]).toEqual({
        topic: "telemetry/vehicles/+/gps",
        qos: 1,
      });

      // 2. Mensaje válido de WKK123
      const ts1 = new Date().toISOString();
      await subscriber.handleIncomingMessage(
        "telemetry/vehicles/WKK123/gps",
        Buffer.from(
          JSON.stringify({
            lat: 4.8133,
            lon: -75.6961,
            velocidad: 36,
            precision: 7.5,
            rumbo: 140,
            odometro: 10200,
            timestamp: ts1,
          }),
          "utf8",
        ),
      );
      expect(events).toHaveLength(1);
      expect(events[0].partition_name).toBe(
        formatGpsPartitionName(new Date(ts1)),
      );

      // 3. Mensaje malformado y tópico inválido no crashean el suscriptor
      await subscriber.handleIncomingMessage(
        "telemetry/vehicles/WKK123/gps",
        Buffer.from("not-valid-json", "utf8"),
      );
      await subscriber.handleIncomingMessage(
        "otro/topico/no-permitido",
        Buffer.from("{}", "utf8"),
      );
      expect(subscriber.getStatus().messagesRejectedTopic).toBe(1);

      // 4. Desconexión del broker + reconexión automática + re-suscripción
      fakeClient.emit("error", new Error("ECONNRESET"));
      fakeClient.emit("offline");
      expect(subscriber.getStatus().state).toBe("DISCONNECTED");
      expect(subscriber.getStatus().connectionErrors).toBe(1);

      fakeClient.emit("reconnect");
      expect(subscriber.getStatus().state).toBe("RECONNECTING");
      expect(subscriber.getStatus().reconnectAttempts).toBe(1);

      fakeClient.emit("connect");
      expect(subscriber.getStatus().state).toBe("CONNECTED");
      expect(fakeClient.subscribedTopics).toHaveLength(2);

      // 5. Mensaje posterior a la reconexión se ingiere con normalidad
      const ts2 = new Date(Date.now() + 1000).toISOString();
      await subscriber.handleIncomingMessage(
        "telemetry/vehicles/WKK123/gps",
        Buffer.from(
          JSON.stringify({
            lat: 4.814,
            lon: -75.695,
            velocidad: 40,
            precision: 6.2,
            rumbo: 145,
            odometro: 10201,
            timestamp: ts2,
          }),
          "utf8",
        ),
      );
      expect(events).toHaveLength(2);
    } finally {
      subscriber.onModuleDestroy();
      expect(fakeClient.ended).toBe(true);
      await service.onModuleDestroy();
    }
  });

  it("OWASP ASVS V10.3: en producción rechaza mqtt:// sin TLS, rejectUnauthorized=false y ausencia de certificados mTLS", () => {
    const ingestPort = new TelemetryIngestChannel();
    const validator = new TelemetryPacketValidator();

    const plaintextSub = new MqttTelemetrySubscriber(
      ingestPort,
      validator,
      createConfig({
        NODE_ENV: "production",
        MQTT_BROKER_URL: "mqtt://broker.local:1883",
      }),
    );
    expect(() =>
      plaintextSub.buildClientOptions("mqtt://broker.local:1883"),
    ).toThrow(/OWASP ASVS V10\.3/);

    const insecureTlsSub = new MqttTelemetrySubscriber(
      ingestPort,
      validator,
      createConfig({
        NODE_ENV: "production",
        MQTT_BROKER_URL: "mqtts://broker.local:8883",
        MQTT_TLS_REJECT_UNAUTHORIZED: "false",
      }),
    );
    expect(() =>
      insecureTlsSub.buildClientOptions("mqtts://broker.local:8883"),
    ).toThrow(/MQTT_TLS_REJECT_UNAUTHORIZED/);

    const missingMtlsCertsSub = new MqttTelemetrySubscriber(
      ingestPort,
      validator,
      createConfig({
        NODE_ENV: "production",
        MQTT_BROKER_URL: "mqtts://broker.local:8883",
        MQTT_TLS_REJECT_UNAUTHORIZED: "true",
      }),
    );
    expect(() =>
      missingMtlsCertsSub.buildClientOptions("mqtts://broker.local:8883"),
    ).toThrow(/mTLS/);
  });

  it("permanece en estado DISABLED cuando MQTT_ENABLED no es true", () => {
    const ingestPort = new TelemetryIngestChannel();
    const validator = new TelemetryPacketValidator();
    const subscriber = new MqttTelemetrySubscriber(
      ingestPort,
      validator,
      createConfig({ MQTT_ENABLED: "false" }),
    );

    subscriber.onModuleInit();
    expect(subscriber.getStatus().state).toBe("DISABLED");
  });
});
