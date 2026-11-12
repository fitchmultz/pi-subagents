import { brokerPidRecord } from "../../src/pi-intercom/broker/pid.ts";

process.send?.(brokerPidRecord());
process.on("disconnect", () => process.exit(0));
