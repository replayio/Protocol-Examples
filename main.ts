import { startClient } from "./protocol/socket";
import type { newSource } from "@recordreplay/protocol";
import groupBy from "lodash/groupBy";
import { createFileCoverage, createCoverageMap } from "istanbul-lib-coverage";
import util from "util";

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

    const hitsByLine = groupBy(hitCounts.hits, entry => entry.location.line);
    const demoFileCoverage = createFileCoverage(demoSourceEntry.url!);

    const allStatementHits = Object.entries(hitsByLine).flatMap(([key, locations]) => {
      const statementHits = locations.map((l, index) => {
        const endColumn = locations[index + 1]?.location.column ?? 255;
        return {
          start: l.location.column,
          end: endColumn,
          hits: l.hits,
          line: l.location.line,
        };
      });
      return statementHits;
    });

    allStatementHits.forEach((statement, index) => {
      demoFileCoverage.statementMap[index] = {
        start: {
          line: statement.line,
          column: statement.start,
        },
        end: {
          line: statement.line,
          column: statement.end,
        },
      };

      demoFileCoverage.s[index] = statement.hits;
    });

    // const lineCoverage = demoFileCoverage.getLineCoverage();
    // console.log("Line coverage: ", lineCoverage);
    const coverageMap = createCoverageMap();
    coverageMap.addFileCoverage(demoFileCoverage);

    process.exit(0);
  });
}

main();
