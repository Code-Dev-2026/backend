import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { IEventDispatcherPort } from "@common/ports/event-dispatcher.port";
import { uuidv7 } from "@common/utils/uuidv7";
import {
  ITelemetryIngestPort,
  TELEMETRY_EVENT_DISPATCHER,
  TELEMETRY_INGEST_PORT,
} from "./domain/telemetry-ingest.port";
import {
  ITelemetryRepository,
  TELEMETRY_REPOSITORY,
} from "./domain/telemetry-repository.port";
import {
  RawTelemetryEnvelope,
  TELEMETRY_GPS_RECORDED_EVENT,
  TelemetryIngestResult,
  TelemetryRecordedEventPayload,
  TelemetryRecordToPersist,
} from "./domain/telemetry.types";
import { IngestGpsTelemetryDto } from "./dto/telemetry-gps.dto";
import { TelemetryPacketValidator } from "./telemetry-packet.validator";

interface QueuedTelemetryEntry {
  readonly record: TelemetryRecordToPersist;
  readonly resolve: (result: TelemetryIngestResult) => void;
  readonly reject: (err: Error) => void;
}

export interface TelemetryIngestionMetrics {
  readonly received: number;
  readonly stored: number;
  readonly discardedLowAccuracy: number;
  readonly duplicatesIgnored: number;
  readonly rejected: number;
  readonly dispatched: number;
  readonly persistenceErrors: number;
  readonly batchesFlushed: number;
  readonly pendingQueueLength: number;
}

/**
 * Servicio de Dominio de Ingesta de Telemetría IoT Vehicular (Issue #12).
 *
 * Principio DIP: depende de `ITelemetryIngestPort`, `ITelemetryRepository` e
 * `IEventDispatcherPort`, permitiendo recibir datos desde MQTT TLS, HTTP fallback
 * o simuladores sin modificar el procesador.
 */
@Injectable()
export class TelemetryService implements OnModuleDestroy {
  private readonly logger = new Logger(TelemetryService.name);
  private readonly batchSize: number;
  private readonly batchFlushMs: number;

  private readonly pendingQueue: QueuedTelemetryEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private activeFlushes = new Set<Promise<void>>();

  private metrics = {
    received: 0,
    stored: 0,
    discardedLowAccuracy: 0,
    duplicatesIgnored: 0,
    rejected: 0,
    dispatched: 0,
    persistenceErrors: 0,
    batchesFlushed: 0,
  };

  constructor(
    @Inject(TELEMETRY_INGEST_PORT)
    private readonly ingestPort: ITelemetryIngestPort,
    @Inject(TELEMETRY_REPOSITORY)
    private readonly telemetryRepository: ITelemetryRepository,
    @Inject(TELEMETRY_EVENT_DISPATCHER)
    private readonly eventDispatcher: IEventDispatcherPort,
    private readonly validator: TelemetryPacketValidator,
    @Optional() configService?: ConfigService,
  ) {
    this.batchSize = Number(
      configService?.get<number>("TELEMETRY_BATCH_SIZE") ?? 100,
    );
    this.batchFlushMs = Number(
      configService?.get<number>("TELEMETRY_BATCH_FLUSH_MS") ?? 100,
    );

    this.ingestPort.registerHandler((envelope) =>
      this.processEnvelope(envelope),
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    await Promise.allSettled(Array.from(this.activeFlushes));
  }

  /**
   * Punto de entrada para el endpoint REST fallback `POST /api/v1/telemetria/gps`.
   * Reutiliza el puerto `ITelemetryIngestPort` para mantener un único flujo de validación,
   * almacenamiento particionado y despacho de eventos.
   */
  async ingestHttpFallback(
    dto: IngestGpsTelemetryDto,
  ): Promise<TelemetryIngestResult> {
    return this.ingestPort.publish({
      source: "HTTP_FALLBACK",
      vehicleIdentifier: dto.placa?.toUpperCase(),
      receivedAtMs: Date.now(),
      payload: dto,
    });
  }

  /**
   * Procesa un sobre telemático crudo proveniente de MQTT, HTTP o simulador.
   */
  async processEnvelope(
    envelope: RawTelemetryEnvelope,
  ): Promise<TelemetryIngestResult> {
    this.metrics.received += 1;
    const receivedAtMs = envelope.receivedAtMs || Date.now();

    const validation = this.validator.validate(envelope);
    if (!validation.ok) {
      if (validation.discardSilently) {
        this.metrics.discardedLowAccuracy += 1;
        return {
          status: "DISCARDED_LOW_ACCURACY",
          stored: false,
          dispatched: false,
          id_gps: null,
          id_vehiculo: null,
          placa: envelope.vehicleIdentifier ?? null,
          id_viaje: null,
          partition_name: null,
          latency_ms: Math.max(0, Date.now() - receivedAtMs),
          reason: validation.reason,
          details: validation.details,
        };
      }

      this.metrics.rejected += 1;
      return {
        status: "REJECTED",
        stored: false,
        dispatched: false,
        id_gps: null,
        id_vehiculo: null,
        placa: envelope.vehicleIdentifier ?? null,
        id_viaje: null,
        partition_name: null,
        latency_ms: Math.max(0, Date.now() - receivedAtMs),
        reason: validation.reason,
        details: validation.details,
      };
    }

    const packet = validation.packet;
    const context = await this.telemetryRepository.resolveVehicleContext({
      id_vehiculo: packet.id_vehiculo,
      placa: packet.placa,
      id_viaje: packet.id_viaje,
    });

    if (!context) {
      this.metrics.rejected += 1;
      return {
        status: "REJECTED",
        stored: false,
        dispatched: false,
        id_gps: null,
        id_vehiculo: packet.id_vehiculo ?? null,
        placa: packet.placa ?? null,
        id_viaje: packet.id_viaje ?? null,
        partition_name: null,
        latency_ms: Math.max(0, Date.now() - receivedAtMs),
        reason: "UNKNOWN_VEHICLE",
        details:
          "Vehículo inactivo/no registrado o sin viaje operativo asociado.",
      };
    }

    const record: TelemetryRecordToPersist = {
      id_gps: uuidv7(),
      id_viaje: context.id_viaje,
      id_vehiculo: context.id_vehiculo,
      placa: context.placa,
      latitud: packet.latitud,
      longitud: packet.longitud,
      velocidad_kmh: packet.velocidad_kmh,
      rumbo_grados: packet.rumbo_grados,
      precision_hdop: packet.precision_hdop,
      precision_metros: packet.precision_metros,
      odometro_km: packet.odometro_km,
      bateria_respaldo_activa: packet.bateria_respaldo_activa,
      fecha_hora: packet.fecha_hora,
      source: packet.source,
      receivedAtMs,
    };

    return this.enqueueForBatch(record);
  }

  /**
   * Fuerza el vaciado inmediato de todos los paquetes actualmente en buffer.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    while (this.pendingQueue.length > 0) {
      const batch = this.pendingQueue.splice(0, this.batchSize);
      await this.executeBatchFlush(batch);
    }
  }

  getMetrics(): TelemetryIngestionMetrics {
    return {
      ...this.metrics,
      pendingQueueLength: this.pendingQueue.length,
    };
  }

  private enqueueForBatch(
    record: TelemetryRecordToPersist,
  ): Promise<TelemetryIngestResult> {
    return new Promise<TelemetryIngestResult>((resolve, reject) => {
      this.pendingQueue.push({ record, resolve, reject });

      if (this.pendingQueue.length >= this.batchSize) {
        if (this.flushTimer) {
          clearTimeout(this.flushTimer);
          this.flushTimer = null;
        }
        const batch = this.pendingQueue.splice(0, this.batchSize);
        this.trackFlush(this.executeBatchFlush(batch));
        return;
      }

      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          if (this.pendingQueue.length > 0) {
            const batch = this.pendingQueue.splice(0, this.batchSize);
            this.trackFlush(this.executeBatchFlush(batch));
          }
        }, this.batchFlushMs);
        this.flushTimer.unref?.();
      }
    });
  }

  private trackFlush(promise: Promise<void>): void {
    this.activeFlushes.add(promise);
    void promise.finally(() => {
      this.activeFlushes.delete(promise);
    });
  }

  private async executeBatchFlush(
    batch: QueuedTelemetryEntry[],
  ): Promise<void> {
    if (batch.length === 0) {
      return;
    }

    try {
      const persistence = await this.telemetryRepository.insertBatch(
        batch.map((entry) => entry.record),
      );
      this.metrics.batchesFlushed += 1;

      const insertedById = new Map(
        persistence.inserted.map((item) => [item.id_gps, item]),
      );

      await Promise.all(
        batch.map(async (entry) => {
          const persisted = insertedById.get(entry.record.id_gps);
          if (!persisted) {
            this.metrics.duplicatesIgnored += 1;
            entry.resolve({
              status: "DUPLICATE_IGNORED",
              stored: false,
              dispatched: false,
              id_gps: null,
              id_vehiculo: entry.record.id_vehiculo,
              placa: entry.record.placa,
              id_viaje: entry.record.id_viaje,
              partition_name: null,
              latency_ms: Math.max(0, Date.now() - entry.record.receivedAtMs),
            });
            return;
          }

          this.metrics.stored += 1;
          const latencyMs = Math.max(
            0,
            Date.now() - entry.record.receivedAtMs,
          );
          const eventPayload: TelemetryRecordedEventPayload = {
            id_gps: persisted.id_gps,
            id_viaje: entry.record.id_viaje,
            id_vehiculo: entry.record.id_vehiculo,
            placa: entry.record.placa,
            latitud: entry.record.latitud,
            longitud: entry.record.longitud,
            velocidad_kmh: entry.record.velocidad_kmh,
            rumbo_grados: entry.record.rumbo_grados,
            precision_metros: entry.record.precision_metros,
            precision_hdop: entry.record.precision_hdop,
            odometro_km: entry.record.odometro_km,
            bateria_respaldo_activa: entry.record.bateria_respaldo_activa,
            fecha_hora: entry.record.fecha_hora.toISOString(),
            partition_name: persisted.partition_name,
            source: entry.record.source,
            latency_ms: latencyMs,
          };

          await this.eventDispatcher.publish(
            TELEMETRY_GPS_RECORDED_EVENT,
            eventPayload,
          );
          this.metrics.dispatched += 1;

          entry.resolve({
            status: "STORED",
            stored: true,
            dispatched: true,
            id_gps: persisted.id_gps,
            id_vehiculo: entry.record.id_vehiculo,
            placa: entry.record.placa,
            id_viaje: entry.record.id_viaje,
            partition_name: persisted.partition_name,
            latency_ms: Math.max(0, Date.now() - entry.record.receivedAtMs),
          });
        }),
      );
    } catch (err: unknown) {
      this.metrics.persistenceErrors += 1;
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.error(
        `Error al persistir lote de ${batch.length} punto(s) GPS: ${error.message}`,
      );
      for (const entry of batch) {
        entry.reject(error);
      }
    }
  }
}
