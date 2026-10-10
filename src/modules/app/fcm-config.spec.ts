import { ConfigService } from "@nestjs/config";
import { AppConfigService } from "./app-config.service";

describe("FCM server configuration", () => {
  it("remains disabled without the complete optional service account", () => {
    expect(new AppConfigService(new ConfigService({})).fcm()).toBeNull();
    expect(
      new AppConfigService(new ConfigService({ FCM_PROJECT_ID: "moh" })).fcm(),
    ).toBeNull();
  });

  it("accepts literal PEM newlines from host configuration", () => {
    const config = new AppConfigService(
      new ConfigService({
        FCM_PROJECT_ID: " moh ",
        FCM_CLIENT_EMAIL: " sender@example.test ",
        FCM_PRIVATE_KEY: "first\\nsecond",
      }),
    );
    expect(config.fcm()).toEqual({
      projectId: "moh",
      clientEmail: "sender@example.test",
      privateKey: "first\nsecond",
    });
  });
});
