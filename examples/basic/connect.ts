/**
 * Demonstrates the client lifecycle: load the stored session, connect, observe state, shut down.
 *
 * Receiving messages is not implemented yet: connect() validates the session with Facebook,
 * then fails honestly with PROTOCOL_NOT_IMPLEMENTED. This example keeps working unchanged
 * once realtime messaging is available.
 *
 *   npm run build
 *   node examples/basic/connect.ts
 */
import {
  createConsoleLogger,
  createPassphraseCodec,
  FEATURE_STATUS,
  FileSessionStore,
  isMessengerError,
  MessengerClient,
} from "fca-unofficial";

const passphrase = process.env["FCA_SESSION_PASSPHRASE"];
const client = new MessengerClient({
  session: new FileSessionStore({
    path: process.env["FCA_SESSION_PATH"] ?? ".session/messenger.json",
    ...(passphrase ? { codec: createPassphraseCodec({ passphrase }) } : {}),
  }),
  logger: createConsoleLogger({ level: "info" }),
});

client.on("stateChange", ({ from, to, reason }) => {
  console.log(`state: ${from} -> ${to}${reason ? ` (${reason})` : ""}`);
});
client.on("error", (error) => {
  console.error(`client error [${error.code}]: ${error.message}`);
});
process.once("SIGINT", () => {
  void client.destroy();
});

console.log(`realtimeReceive: ${FEATURE_STATUS.realtimeReceive.status}`);
try {
  await client.connect();
  console.log("connected");
} catch (error) {
  if (!isMessengerError(error)) throw error;
  console.error(`connect() failed [${error.code}]: ${error.message}`);
  process.exitCode = 1;
} finally {
  console.log("health:", client.health());
  await client.destroy();
}
