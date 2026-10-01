/**
 * Connects with the stored session and prints message events until Ctrl+C.
 *
 * Messages that arrived while the program was offline are delivered after it connects,
 * marked `recovered`. The first run on a session only records the current inbox position
 * (no backlog is replayed). Output stays on this machine.
 *
 *   npm run build
 *   node examples/basic/connect.ts
 */
import {
  createConsoleLogger,
  createPassphraseCodec,
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

client.on("message", (message) => {
  const from = message.isFromMe ? "me" : message.senderId;
  const tag = message.recovered ? " [recovered]" : "";
  console.log(`[${message.threadId}] ${from}: ${message.text ?? "(no text)"}${tag}`);
});
client.on("messageEdit", (edit) => {
  console.log(`edited ${edit.messageId}: ${edit.text}`);
});
client.on("messageDelete", (deletion) => {
  console.log(`${deletion.reason} ${deletion.messageId} in ${deletion.threadId}`);
});
client.on("reactionAdd", (reaction) => {
  console.log(`${reaction.actorId} reacted ${reaction.reaction ?? ""} to ${reaction.messageId}`);
});
client.on("typing", ({ threadId, userId, isTyping }) => {
  if (isTyping) console.log(`${userId} is typing in ${threadId}`);
});

process.once("SIGINT", () => {
  console.log("health:", client.health());
  void client.destroy();
});

try {
  await client.connect();
  console.log("connected; listening (Ctrl+C to stop)");
} catch (error) {
  if (!isMessengerError(error)) throw error;
  console.error(`connect() failed [${error.code}]: ${error.message}`);
  process.exitCode = 1;
  await client.destroy();
}
