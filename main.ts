import { startClient } from "./protocol/socket";
import type { newSource } from "@recordreplay/protocol";

async function main() {
  const [node, script, recordingId] = process.argv;

  if (!recordingId || typeof recordingId !== "string") {
    console.error("Please provide a Replay recording ID");
    process.exit(1);
  }

  processRecording(recordingId);
}

function processRecording(recordingId: string) {
  startClient(async client => {
    const { sessionId } = await client.Recording.createSession({ recordingId });

    const sources: newSource[] = [];
    // Fetch the sources
    client.Debugger.addNewSourceListener(source => sources.push(source));
    await client.Debugger.findSources({}, sessionId);

    console.log("Sources: ", sources);

    process.exit(0);
  });
}

main();
