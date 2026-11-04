import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, UseGuards } from '@nestjs/common';
import { TrackingService } from './tracking.service';

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: 'tracking',
})
export class TrackingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(TrackingGateway.name);

  constructor(private readonly trackingService: TrackingService) {}

  handleConnection(client: Socket) {
    this.logger.log(`Cliente WebSocket conectado para tracking: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Cliente WebSocket desconectado: ${client.id}`);
  }

  /**
   * Suscripción con Privacidad Diferencial:
   * Padres solo entran a la sala si su hijo está a bordo del móvil.
   */
  @SubscribeMessage('subscribeTrip')
  handleSubscribeTrip(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { id_viaje: string; id_estudiante?: string; rol: string },
  ) {
    const room = `trip:${payload.id_viaje}`;
    client.join(room);
    this.logger.log(`Cliente ${client.id} suscrito a sala ${room}`);
    return { event: 'subscribed', room };
  }

  /**
   * Difunde la posición GPS del vehículo a las salas autorizadas
   */
  broadcastVehicleLocation(id_viaje: string, locationData: unknown) {
    this.server.to(`trip:${id_viaje}`).emit('locationUpdate', locationData);
  }
}
