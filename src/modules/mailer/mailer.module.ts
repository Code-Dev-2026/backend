import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createMailTransport,
  MAIL_TRANSPORT,
  MailerService,
  MailTransport,
} from "./mailer.service";

@Module({
  providers: [
    {
      provide: MAIL_TRANSPORT,
      inject: [ConfigService],
      useFactory: createMailTransport,
    },
    {
      provide: MailerService,
      inject: [MAIL_TRANSPORT, ConfigService],
      useFactory: (transport: MailTransport, config: ConfigService) =>
        new MailerService(transport, config),
    },
  ],
  exports: [MailerService],
})
export class MailerModule {}
