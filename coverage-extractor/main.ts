import fs from "fs";
import { startClient } from "./protocol/socket";
import type { getHitCountsResult, newSource } from "@recordreplay/protocol";
import groupBy from "lodash/groupBy";
import { createFileCoverage, createCoverageMap } from "istanbul-lib-coverage";
import { createContext } from "istanbul-lib-report";
import { create as createNewReport } from "istanbul-reports";

const DEFAULT_DEMO_RECORDING_ID = "be1a4568-6c84-474c-a9eb-3a0491a792d8";

async function main() {
  const [node, script, recordingId = DEFAULT_DEMO_RECORDING_ID] = process.argv;

  if (!recordingId || typeof recordingId !== "string") {
    console.error("Please provide a Replay recording ID");
    process.exit(1);
  }

  processRecording(recordingId);
}

interface SourceGroups {
  src: newSource[];
  node_modules: newSource[];
  other: newSource[];
}

const reIsJsSourceFile = /(js|ts)x?(\?[\w\d]+)*$/;

function processRecording(recordingId: string) {
  startClient(async client => {
    const { sessionId } = await client.Recording.createSession({ recordingId });

    const sources: newSource[] = [];
    // Fetch the sources
    client.Debugger.addNewSourceListener(source => sources.push(source));
    await client.Debugger.findSources({}, sessionId);

    const sourceGroups: SourceGroups = {
      src: [],
      node_modules: [],
      other: [],
    };

    sources.forEach(entry => {
      if (!entry.url || !reIsJsSourceFile.test(entry.url)) {
        sourceGroups.other.push(entry);
        return;
      }

      const url = new URL(entry.url);
      // TODO This check for "real sources" is specific to the "Redux CSB" demo recording atm
      if (
        url.pathname.startsWith("/src") &&
        url.protocol !== "webpack:" &&
        entry.kind === "sourceMapped"
      ) {
        sourceGroups.src.push(entry);
      } else if (url.pathname.startsWith("/node_modules")) {
        sourceGroups.node_modules.push(entry);
      } else {
        sourceGroups.other.push(entry);
      }
    });

    if (sourceGroups.src.length === 0) {
      console.log("No matching sources found, exiting");
      process.exit(0);
    }

    const coverageMap = createCoverageMap();

    const fileSourceContentsMap: Record<string, string> = {};

    for (let sourceEntry of sourceGroups.src) {
      console.log("Fetching source data: ", sourceEntry.url);
      const demoSourceText = await client.Debugger.getSourceContents(
        {
          sourceId: sourceEntry.sourceId,
        },
        sessionId
      );

      const fileUrl = new URL(sourceEntry.url!);
      const filePath = fileUrl.pathname;

      fileSourceContentsMap[filePath] = demoSourceText.contents;

      const { lineLocations } = await client.Debugger.getPossibleBreakpoints(
        {
          sourceId: sourceEntry.sourceId,
        },
        sessionId
      );

      let hitCounts: getHitCountsResult = {
        hits: [],
      };

      try {
        hitCounts = await client.Debugger.getHitCounts(
          {
            sourceId: sourceEntry.sourceId,
            locations: lineLocations,
            maxHits: 250,
          },
          sessionId
        );
      } catch (err: any) {
        console.error("Error fetching ", sourceEntry.url, err.message);
      }

      const hitsByLine = groupBy(hitCounts.hits, entry => entry.location.line);

      const fileCoverage = createFileCoverage(filePath);

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
        fileCoverage.statementMap[index] = {
          start: {
            line: statement.line,
            column: statement.start,
          },
          end: {
            line: statement.line,
            column: statement.end,
          },
        };

        fileCoverage.s[index] = statement.hits;
      });

      coverageMap.addFileCoverage(fileCoverage);
    }

    const outputCoveragePath = `./coverage/${recordingId}`;

    if (fs.existsSync(outputCoveragePath)) {
      fs.rmSync(outputCoveragePath, { recursive: true, force: true });
    }

    const context = createContext({
      dir: outputCoveragePath,
      coverageMap,
      sourceFinder: filePath => {
        if (filePath in fileSourceContentsMap) {
          return fileSourceContentsMap[filePath];
        }
        console.error(`Could not find file for source path: ${filePath}`);
        return "";
      },
    });

    const report = createNewReport("html", {});
    report.execute(context);

    process.exit(0);
  });
}

main();
