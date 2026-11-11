import { brokerPidRecord } from "../../src/pi-intercom/broker/pid.ts";
import { acquireSpawnClaim } from "../../src/pi-intercom/broker/spawn-claim.ts";

const claim = process.argv[2];
if (claim !== undefined) {
  acquireSpawnClaim(claim);
}

process.send?.(brokerPidRecord());
process.on("disconnect", () => process.exit(0));
