import * as fs from "fs";
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { connect, IClientOptions } from "mqtt";
import {
  ITelemetryIngestPort,
  TELEMETRY_INGEST_PORT,
} from "../domain/telemetry-ingest.port";
import { TelemetryPacketValidator } from "../telemetry-packet.validator";

export const MQTT_CLIENT_FACTORY = Symbol("MQTT_CLIENT_FACTORY");

export type MqttConnectionState =
  | "DISABLED"
  | "CONNECTING"
  | "CONNECTED"
  | "RECONNECTING"
  | "DISCONNECTED";

export interface MqttClientLike {
  on(event: "connect", listener: () => void): this;
  on(event: "reconnect", listener: () => void): this;
  on(event: "offline", listener: () => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(
    event: "message",
    listener: (topic: string, payload: Buffer) => void,
  ): this;
  subscribe(
    topic: string,
    opts: { qos: 0 | 1 | 2 },
    callback?: (err: Error | null) => void,
  ): void;
  end(force?: boolean, callback?: () => void): void;
}

export type MqttClientFactory = (
  brokerUrl: string,
  options: IClientOptions,
) => MqttClientLike;

export interface MqttSubscriberStatus {
  readonly state: MqttConnectionState;
  readonly topicPattern: string;
  readonly reconnectAttempts: number;
  readonly messagesReceived: number;
  readonly messagesRejectedTopic: number;
  readonly connectionErrors: number;
  readonly lastError: string | null;
}

/**
 * Adaptador de infraestructura MQTT TLS/mTLS con reconexión automática
 * (Issue #12 — OWASP ASVS V10.3).
 *
 * Se suscribe a `telemetry/vehicles/+/gps` y entrega los paquetes al puerto
 * `ITelemetryIngestPort` sin acoplar el procesador de dominio al transporte.
 */
@Injectable()
export class MqttTelemetrySubscriber implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttTelemetrySubscriber.name);
  private readonly topicPattern: string;
  private client: MqttClientLike | null = null;
  private shuttingDown = false;

  private state: MqttConnectionState = "DISABLED";
  private reconnectAttempts = 0;
  private messagesReceived = 0;
  private messagesRejectedTopic = 0;
  private connectionErrors = 0;
  private lastError: string | null = null;

  constructor(
    @Inject(TELEMETRY_INGEST_PORT)
    private readonly ingestPort: ITelemetryIngestPort,
    private readonly validator: TelemetryPacketValidator,
    @Optional() private readonly configService?: ConfigService,
    @Optional()
    @Inject(MQTT_CLIENT_FACTORY)
    private readonly clientFactory: MqttClientFactory = (url, opts) =>
      connect(url, opts) as unknown as MqttClientLike,
  ) {
    this.topicPattern =
      this.configService?.get<string>("MQTT_TOPIC_PATTERN") ??
      "telemetry/vehicles/+/gps";
  }

  onModuleInit(): void {
    const enabled = this.configService?.get<string>("MQTT_ENABLED") === "true";
    if (!enabled) {
      this.state = "DISABLED";
      return;
    }

    this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  start(): void {
    if (this.client) {
      return;
    }

    const brokerUrl =
      this.configService?.get<string>("MQTT_BROKER_URL") ??
      "mqtts://localhost:8883";
    const options = this.buildClientOptions(brokerUrl);

    this.shuttingDown = false;
    this.state = "CONNECTING";
    this.client = this.clientFactory(brokerUrl, options);

    this.client.on("connect", () => {
      this.state = "CONNECTED";
      this.lastError = null;
      this.logger.log(
        `Conectado al broker MQTT (${this.sanitizeBrokerUrl(brokerUrl)}). Suscribiendo a "${this.topicPattern}".`,
      );

      this.client?.subscribe(this.topicPattern, { qos: 1 }, (err) => {
        if (err) {
          this.connectionErrors += 1;
          this.lastError = err.message;
          this.logger.error(
            `Error al suscribirse al tópico "${this.topicPattern}": ${err.message}`,
          );
        }
      });
    });

    this.client.on("reconnect", () => {
      this.state = "RECONNECTING";
      this.reconnectAttempts += 1;
      this.logger.warn(
        `Reconectando al broker MQTT (intento #${this.reconnectAttempts})...`,
      );
    });

    this.client.on("offline", () => {
      if (!this.shuttingDown) {
        this.state = "DISCONNECTED";
        this.logger.warn("Broker MQTT fuera de línea; esperando reconexión.");
      }
    });

    this.client.on("close", () => {
      if (!this.shuttingDown && this.state !== "RECONNECTING") {
        this.state = "DISCONNECTED";
      }
    });

    this.client.on("error", (err: Error) => {
      this.connectionErrors += 1;
      this.lastError = err.message;
      this.logger.error(`Error de transporte MQTT: ${err.message}`);
    });

    this.client.on("message", (topic: string, payload: Buffer) => {
      void this.handleIncomingMessage(topic, payload);
    });
  }

  stop(): void {
    if (!this.client) {
      return;
    }
    this.shuttingDown = true;
    const active = this.client;
    this.client = null;
    this.state = "DISCONNECTED";
    active.end(true);
  }

  async handleIncomingMessage(topic: string, payload: Buffer): Promise<void> {
    this.messagesReceived += 1;
    const receivedAtMs = Date.now();
    const vehicleIdentifier = this.validator.extractVehicleFromTopic(topic);

    if (!vehicleIdentifier) {
      this.messagesRejectedTopic += 1;
      this.logger.warn(
        `Mensaje MQTT ignorado por tópico no permitido: "${topic}".`,
      );
      return;
    }

    try {
      await this.ingestPort.publish({
        source: "MQTT",
        topic,
        vehicleIdentifier,
        receivedAtMs,
        payload,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Fallo al enrutar telemetría MQTT del vehículo ${vehicleIdentifier}: ${msg}`,
      );
    }
  }

  getStatus(): MqttSubscriberStatus {
    return {
      state: this.state,
      topicPattern: this.topicPattern,
      reconnectAttempts: this.reconnectAttempts,
      messagesReceived: this.messagesReceived,
      messagesRejectedTopic: this.messagesRejectedTopic,
      connectionErrors: this.connectionErrors,
      lastError: this.lastError,
    };
  }

  buildClientOptions(brokerUrl: string): IClientOptions {
    const nodeEnv =
      this.configService?.get<string>("NODE_ENV") ?? "development";
    const isProduction = nodeEnv === "production";
    const isSecureProtocol =
      brokerUrl.startsWith("mqtts://") || brokerUrl.startsWith("wss://");

    const rejectUnauthorized =
      this.configService?.get<string>("MQTT_TLS_REJECT_UNAUTHORIZED") !==
      "false";

    const caPath = this.readNonEmptyConfig("MQTT_TLS_CA_PATH");
    const certPath = this.readNonEmptyConfig("MQTT_TLS_CERT_PATH");
    const keyPath = this.readNonEmptyConfig("MQTT_TLS_KEY_PATH");
    const username = this.readNonEmptyConfig("MQTT_USERNAME");
    const password = this.readNonEmptyConfig("MQTT_PASSWORD");

    // OWASP ASVS V10.3: En producción exigir transporte cifrado y mTLS estricto
    if (isProduction) {
      if (!isSecureProtocol) {
        throw new Error(
          "OWASP ASVS V10.3: MQTT_BROKER_URL debe usar mqtts:// o wss:// en producción.",
        );
      }
      if (!rejectUnauthorized) {
        throw new Error(
          "OWASP ASVS V10.3: MQTT_TLS_REJECT_UNAUTHORIZED no puede desactivarse en producción.",
        );
      }
      if (!caPath || !certPath || !keyPath) {
        throw new Error(
          "OWASP ASVS V10.3: En producción son obligatorios MQTT_TLS_CA_PATH, MQTT_TLS_CERT_PATH y MQTT_TLS_KEY_PATH para mTLS.",
        );
      }
    }

    const clientIdBase =
      this.configService?.get<string>("MQTT_CLIENT_ID") ??
      "camino-seguro-backend-telemetry";
    const reconnectPeriod = Number(
      this.configService?.get<number>("MQTT_RECONNECT_PERIOD_MS") ?? 5000,
    );

    const options: IClientOptions = {
      clientId: `${clientIdBase}-${process.pid}`,
      clean: true,
      keepalive: 30,
      connectTimeout: 10_000,
      reconnectPeriod,
      rejectUnauthorized,
    };

    if (username) {
      options.username = username;
    }
    if (password) {
      options.password = password;
    }

    if (caPath) {
      options.ca = fs.readFileSync(caPath);
    }
    if (certPath) {
      options.cert = fs.readFileSync(certPath);
    }
    if (keyPath) {
      options.key = fs.readFileSync(keyPath);
    }

    return options;
  }

  private readNonEmptyConfig(key: string): string | undefined {
    const value = this.configService?.get<string>(key);
    if (!value || value.trim().length === 0) {
      return undefined;
    }
    return value.trim();
  }

  private sanitizeBrokerUrl(rawUrl: string): string {
    try {
      const parsed = new URL(rawUrl);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return "<broker-mqtt>";
    }
  }
}
