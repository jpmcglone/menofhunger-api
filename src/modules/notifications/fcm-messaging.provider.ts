import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { cert, deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getMessaging, type Message } from "firebase-admin/messaging";
import { AppConfigService } from "../app/app-config.service";

/** Lazy initialization: installations can register while server credentials are unset. */
@Injectable()
export class FcmMessagingProvider implements OnModuleDestroy {
  private app?: App;

  constructor(private readonly config: AppConfigService) {}

  configured(): boolean {
    return this.config.fcm() !== null;
  }

  async send(message: Message): Promise<string> {
    const config = this.config.fcm();
    if (!config) throw new Error("FCM is not configured");
    this.app ??= initializeApp(
      { projectId: config.projectId, credential: cert(config) },
      "moh-fcm",
    );
    return getMessaging(this.app).send(message);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.app) await deleteApp(this.app);
  }
}
