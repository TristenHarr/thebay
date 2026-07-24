import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor wraps the SAME web build (dist/site/app) into native iOS/Android
 * store apps — one codebase, no fork. In dev, `server.url` can point at the
 * deployed site so the shell loads live; for a store build, drop `server` and
 * ship the bundled webDir.
 *
 * One-time setup (requires Xcode / Android SDK):
 *   npm i -D @capacitor/cli && npm i @capacitor/core @capacitor/ios @capacitor/android @capacitor/push-notifications
 *   npm run build-web
 *   npx cap add ios && npx cap add android
 *   npx cap sync            # after every web build
 *   npx cap open ios        # build & run in Xcode
 */
const config: CapacitorConfig = {
  appId: "events.thebay.app",
  appName: "The Bay",
  webDir: "dist/site/app",
  backgroundColor: "#0b0e13",
  ios: { contentInset: "always", backgroundColor: "#0b0e13" },
  android: { backgroundColor: "#0b0e13" },
  plugins: {
    PushNotifications: { presentationOptions: ["badge", "sound", "alert"] },
  },
  // For live-reload against the deployed PWA during native bring-up, uncomment:
  // server: { url: "https://thebay.events/app/", cleartext: false },
};

export default config;
