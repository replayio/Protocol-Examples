import { startClient } from "./protocol/socket";
import type { newSource, ProtocolClient, Location, PointDescription } from "@recordreplay/protocol";

const DEFAULT_DEMO_RECORDING_ID = "8b2cfbbd-da01-47cb-a1c4-f89c4f1f1198";

async function main() {
  const [node, script, recordingId = DEFAULT_DEMO_RECORDING_ID] = process.argv;

  if (!recordingId || typeof recordingId !== "string") {
    console.error("Please provide a Replay recording ID");
    process.exit(1);
  }

  processRecording(recordingId);
}

const FIBER_PROPERTIES = [
  "tag",
  "key",
  "elementType",
  "type",
  "stateNode",
  "return",
  "child",
  "sibling",
  "index",
  "ref",
  "pendingProps",
  "memoizedProps",
  "updateQueue",
  "memoizedState",
  "dependencies",
  "mode",
  "effectTag",
  "nextEffect",
  "firstEffect",
  "lastEffect",
  "expirationTime",
  "childExpirationTime",
  "alternate",
];

function getSourceLocationPoints(
  client: ProtocolClient,
  sessionId: string,
  location: Location
): Promise<PointDescription[]> {
  // TODO The Analysis API was removed from our protocol a while back.
  // Today you'd use `Session.findPoints` and `Session.runEvaluation`.
  return new Promise(async resolve => {
    const { analysisId } = await client.Analysis.createAnalysis(
      {
        mapper: "",
        effectful: false,
      },
      sessionId
    );

    client.Analysis.addLocation({ analysisId, location }, sessionId);
    client.Analysis.findAnalysisPoints({ analysisId }, sessionId);
    client.Analysis.addAnalysisPointsListener(({ points }) => resolve(points));
  });
}

// This function checks an execution point to see if we are paused in a react component.
// If we are, we then check to see if the component is rendering or mounting
//
// 1. we first check to see if the 2nd frame is in a file that has the url `react-dom`
// 2. we then check the 2nd frame to find the binding that represents the fiber node
// 3. we then check the fiber node to see if its alternate property is null
async function isReactComponentMounting(
  client: ProtocolClient,
  sessionId: string,
  point: string,
  sources: newSource[]
) {
  const pause = await client.Session.createPause({ point }, sessionId);
  const secondFrame = pause.data.frames![1];
  const secondFrameSourceId = secondFrame.location[secondFrame.location.length - 2].sourceId;
  const frameSource = sources.find(source => source.sourceId == secondFrameSourceId)!;

  if (!frameSource.url!.includes("react-dom")) {
    console.log("Not a React component render");
    return;
  }

  // Get local scope bindings
  const localScopeId = secondFrame.scopeChain[0];
  const scope = await client.Pause.getScope({ scope: localScopeId }, sessionId, pause.pauseId);

  // Loop over the bindings to find the React fiber node
  for (const obj of scope.data.scopes![0].bindings!) {
    if (obj.object) {
      const preview = await client.Pause.getObjectPreview(
        { object: obj.object },
        sessionId,
        pause.pauseId
      );
      const properties = preview.data.objects![0]?.preview!.properties!;
      const propertyNames = properties?.map(p => p.name);

      // Is fiber if all the properties are there
      if (!propertyNames || FIBER_PROPERTIES.some(p => !propertyNames.includes(p))) {
        continue;
      }

      // Component is mounting if the alternate property is null
      // NOTE: This is both a hacky check, and something likely to go away in future  versions of React
      const alternate = properties.find(property => property.name == "alternate");
      const isMounting = alternate?.value === null;

      console.log(`React component is ${isMounting ? "mounting" : "rendering"}`);
      return;
    }
  }
}

function processRecording(recordingId: string) {
  startClient(async client => {
    const { sessionId } = await client.Recording.createSession({ recordingId });

    const sources: newSource[] = [];

    // Fetch the sources
    client.Debugger.addNewSourceListener(source => sources.push(source));
    await client.Debugger.findSources({}, sessionId);

    // Get the breakpoint hits at line 18 of `search/index`
    const source = sources.find(
      source => source?.url == "webpack:///src/components/search/index.js"
    )!;

    const location: Location = { sourceId: source.sourceId, line: 18, column: 2 };
    const points = await getSourceLocationPoints(client, sessionId, location);

    // The first time we pause the component is mounting.
    // The second time we puse the component is rendering.
    await isReactComponentMounting(client, sessionId, points[0].point, sources);
    await isReactComponentMounting(client, sessionId, points[1].point, sources);

    process.exit(0);
  });
}

main();
