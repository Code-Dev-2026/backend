import { Injectable, Logger } from "@nestjs/common";
import { IEventDispatcherPort } from "@common/ports/event-dispatcher.port";

export interface DispatchedEventRecord<T = unknown> {
  readonly eventName: string;
  readonly payload: T;
  readonly dispatchedAt: string;
}

const MAX_RECENT_EVENTS = 500;

/**
 * Bus de eventos en memoria que implementa `IEventDispatcherPort` (Issue #12).
 * Aísla excepciones de suscriptores para que ningún consumidor downstream
 * detenga la ingesta telemática de alta frecuencia.
 */
@Injectable()
export class InMemoryEventDispatcher implements IEventDispatcherPort {
  private readonly logger = new Logger(InMemoryEventDispatcher.name);
  private readonly handlers = new Map<
    string,
    Set<(payload: unknown) => Promise<void>>
  >();
  private readonly recentEvents: DispatchedEventRecord[] = [];
  private totalPublished = 0;

  async publish<T = unknown>(eventName: string, payload: T): Promise<void> {
    this.totalPublished += 1;
    this.recentEvents.push({
      eventName,
      payload,
      dispatchedAt: new Date().toISOString(),
    });
    if (this.recentEvents.length > MAX_RECENT_EVENTS) {
      this.recentEvents.shift();
    }

    const listeners = this.handlers.get(eventName);
    if (!listeners || listeners.size === 0) {
      return;
    }

    await Promise.all(
      Array.from(listeners).map(async (handler) => {
        try {
          await handler(payload);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(
            `Error en suscriptor del evento "${eventName}": ${message}`,
          );
        }
      }),
    );
  }

  subscribe<T = unknown>(
    eventName: string,
    handler: (payload: T) => Promise<void>,
  ): void {
    const existing = this.handlers.get(eventName) ?? new Set();
    existing.add(handler as (payload: unknown) => Promise<void>);
    this.handlers.set(eventName, existing);
  }

  unsubscribe<T = unknown>(
    eventName: string,
    handler: (payload: T) => Promise<void>,
  ): void {
    const existing = this.handlers.get(eventName);
    if (!existing) {
      return;
    }
    existing.delete(handler as (payload: unknown) => Promise<void>);
    if (existing.size === 0) {
      this.handlers.delete(eventName);
    }
  }

  getTotalPublished(): number {
    return this.totalPublished;
  }

  getRecentEvents(eventName?: string): DispatchedEventRecord[] {
    const items = eventName
      ? this.recentEvents.filter((entry) => entry.eventName === eventName)
      : this.recentEvents;
    return items.slice();
  }

  clear(): void {
    this.recentEvents.length = 0;
    this.totalPublished = 0;
  }
}
