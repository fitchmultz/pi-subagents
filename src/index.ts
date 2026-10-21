import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agents from "./agent/index.ts";
import intercom from "./pi-intercom/index.ts";

export default function extension(pi: ExtensionAPI): void {
  agents(pi);
  intercom(pi);
}
