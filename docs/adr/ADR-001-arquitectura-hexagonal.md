# ADR-001: Arquitectura Hexagonal (Ports & Adapters) y Clean Architecture

- **Estado:** Aceptado
- **Fecha:** 2026-11-07
- **Autor:** Equipo de Arquitectura Backend — Camino Seguro
- **Contexto:** Issue #1 (Épica de Orquestación General y Arquitectura)

---

## 1. Contexto y Problema

El sistema backend "Camino Seguro" es responsable de gobernar la cadena de custodia física y digital de menores de edad en el transporte escolar del Colegio San Benito del Otún (Pereira, Risaralda). El sistema debe integrar múltiples tecnologías de infraestructura:
- Base de datos relacional PostgreSQL 16 con extensión PostGIS para datos geoespaciales.
- Broker MQTT para ingesta continua de paquetes de telemetría IoT vehicular cada 5 segundos.
- Pasarela WebSockets (Socket.IO) para retransmisión en tiempo real hacia aplicaciones móviles de familias y monitores.
- Motor de auditoría inmutable WORM y bóveda criptográfica para cumplimiento estricto de la Ley 1581 de Habeas Data y directrices OWASP ASVS L2.

Un acoplamiento directo de la lógica de negocio a estas tecnologías externas provocaría fragilidad, dificultad para ejecutar pruebas unitarias aisladas y resistencia al cambio ante evoluciones de infraestructura.

---

## 2. Decisión de Arquitectura

Se adopta formalmente el patrón de **Arquitectura Hexagonal (Ports & Adapters)** combinado con **Clean Architecture** estructurado en NestJS.

```
       +-----------------------------------------------------------+
       |                  INFRASTRUCTURE / ADAPTERS               |
       |                                                           |
       |    [REST Controllers]   [WebSocket Gateways]  [MQTT]      |
       |              \                  |            /            |
       |               v                 v           v             |
       |      +---------------------------------------------+      |
       |      |             APPLICATION LAYER               |      |
       |      |     (Use Cases / Application Services)      |      |
       |      |                                             |      |
       |      |      +-------------------------------+      |      |
       |      |      |         DOMAIN LAYER          |      |      |
       |      |      |  (Entities, Value Objects,    |      |      |
       |      |      |   Domain Ports / Interfaces,  |      |      |
       |      |      |   FSM & Invariants)           |      |      |
       |      |      +-------------------------------+      |      |
       |      |                                             |      |
       |      +---------------------------------------------+      |
       |               ^                 ^           ^             |
       |              /                  |            \            |
       |    [PostgreSQL/PostGIS]   [BullMQ/Redis]  [Push FCM]      |
       |                                                           |
       +-----------------------------------------------------------+
```

### Capas del Sistema:

1. **Capa de Dominio (`Domain`):**
   - Contiene las entidades esenciales (`Estudiante`, `Viaje`, `Custodia`, `Ruta`), objetos de valor (Value Objects), reglas de negocio invariantes (RN-01 a RN-05) y las definiciones abstractas de **Puertos (Interfaces)**.
   - Es completamente agnóstica a NestJS, frameworks web, ORMs o librerías externas.
   - Aplica el **Principio de Inversión de Dependencias (DIP)**: el dominio define qué necesita a través de interfaces (`IPort`), nunca depende de implementaciones concretas.

2. **Capa de Aplicación (`Application`):**
   - Orquesta los flujos de casos de uso del sistema (ej. abordar estudiante por QR, validar receptor en parada, despachar evento de desvío >300m).
   - Consume los puertos de dominio y coordina la lógica transaccional.

3. **Capa de Infraestructura y Adaptadores (`Infrastructure / Adapters`):**
   - **Adaptadores Primarios / Conducidos (Driving/Inbound):** Controladores REST (`@Controller`), Gateways WebSocket (`@WebSocketGateway`), Microservicios MQTT (`@MessagePattern`).
   - **Adaptadores Secundarios / Conducentes (Driven/Outbound):** Repositorios PostgreSQL, clientes de correo/SMS/Push, persistencia en disco o almacenamiento S3/local.

---

## 3. Consecuencias y Beneficios

- **Testabilidad Aislada:** La capa de dominio y casos de uso se prueban al 100% mediante mocks en Jest sin requerir conexión a base de datos real o brokers activos.
- **Principio DIP Garantizado:** Modificaciones en drivers de base de datos o transporte en tiempo real no impactan los contratos ni la lógica de negocio.
- **Alineación con los 5 Sprints:** Cada equipo de desarrollo puede implementar adaptadores específicos (Issues #2 a #20) respetando los contratos de interfaces ya unificados en el core.
