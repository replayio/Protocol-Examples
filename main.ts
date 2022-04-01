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

    const demoSourceEntry = sources.find(s => s.url?.endsWith("demo-script.js"))!;

    console.log("Demo source entry: ", demoSourceEntry);

    const demoSourceText = await client.Debugger.getSourceContents(
      {
        sourceId: demoSourceEntry.sourceId,
      },
      sessionId
    );

    // console.log("Demo source: ", demoSourceText.contents);
    const { lineLocations } = await client.Debugger.getPossibleBreakpoints(
      {
        sourceId: demoSourceEntry.sourceId,
      },
      sessionId
    );

    const hitCounts = await client.Debugger.getHitCounts(
      {
        sourceId: demoSourceEntry.sourceId,
        locations: lineLocations,
        maxHits: 250,
      },
      sessionId
    );

    console.log("Hit counts: ", hitCounts.hits.slice(0, 10));

    process.exit(0);
  });
}

main();
