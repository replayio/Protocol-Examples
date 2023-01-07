import { startClient } from "./protocol/socket";
import fs from "fs";
import path from "path";
import type {
  newSource,
  ProtocolClient,
  Location,
  PointDescription,
  PaintPoint,
} from "@recordreplay/protocol";
const ffmpeg = require("fluent-ffmpeg");

const DEFAULT_DEMO_RECORDING_ID = "8b2cfbbd-da01-47cb-a1c4-f89c4f1f1198";

async function main() {
  const [node, script, recordingId = DEFAULT_DEMO_RECORDING_ID] = process.argv;

  processRecording(recordingId);
}

async function fetchPaintPoints({
  client,
  sessionId,
}: {
  client: ProtocolClient;
  sessionId: string;
}) {
  const findPaints = client.Graphics.findPaints({}, sessionId);
  let gPaints: PaintPoint[] = [];
  client.Graphics.addPaintPointsListener(({ paints }) => {
    gPaints.push(...paints);
  });

  await findPaints;
  return gPaints;
}

async function fetchGraphics(
  paintPoints: PaintPoint[],
  { client, sessionId }: { client: ProtocolClient; sessionId: string }
) {
  for (const point of paintPoints) {
    console.log(point.point);
    const { screen } = await client.Graphics.getPaintContents(
      { point: point.point, mimeType: point.screenShots[0].mimeType },
      sessionId
    );
    fs.writeFileSync(
      path.join(__dirname, `/paints/${point.point}.jpeg`),
      Buffer.from(screen.data, "base64")
    );
  }
}

async function createVideo() {
  // Replace 'images' with the array of image file paths
  const images = fs
    .readdirSync(path.join(__dirname, "/paints"))
    .map(path => `${__dirname}/paints/${path}`);
  console.log(images);

  // Create a new ffmpeg process
  const proc = ffmpeg();

  // Add all the images to the process
  images.forEach(image => {
    console.log(image);
    proc.addInput(image);
  });

  // Set the output options for the process
  // Replace 'output.mp4' with the desired output file name
  proc
    .on("end", () => {
      console.log("Finished processing");
    })
    .on("error", err => {
      console.log("Error:", err);
    })
    .mergeToFile("output.mp4", __dirname)
    .withDuration("5");
}

function processRecording(recordingId: string) {
  startClient(async client => {
    const { sessionId } = await client.Recording.createSession({ recordingId });
    console.log(sessionId);
    const paintPoints = await fetchPaintPoints({ client, sessionId });
    await fetchGraphics(paintPoints, { client, sessionId });
    process.exit(0);
  });
}

startClient(() => {});
// main();
createVideo();
