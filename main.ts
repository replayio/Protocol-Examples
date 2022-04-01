import { startClient } from "./protocol/socket";

async function main() {
  const [node, script, recordingId] = process.argv;

  if (!recordingId || typeof recordingId !== "string") {
    console.error("Please provide a Replay recording ID");
    process.exit(1);
  }

  processRecording(recordingId);
}

async function processRecording(recordingId: string) {
  console.log("Processing recording: ", recordingId);
}

main();
