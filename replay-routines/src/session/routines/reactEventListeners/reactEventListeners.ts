/* Copyright 2023 Record Replay Inc. */

// The main React Event Listeners routine implementation

import {
  Annotation,
  MouseEvent as ReplayMouseEvent,
  KeyboardEvent as ReplayKeyboardEvent,
  TimeStampedPoint,
  FunctionOutline,
} from "@replayio/protocol";

import { Context } from "../../../shared/context";
import { Routine, RoutineError, RoutineSpec } from "../routine";

import { parseBuildIdComponents } from "../../../shared/utils";

import { createProtocolClient } from "../shared/protocolClient";
import { compareExecutionPoints, compareTimeStampedPoints } from "../shared/time";
import { ReplayClient } from "../shared/replayClient";
import { createCaches } from "../shared/caches/ProtocolDataCaches";
import { buildDateStringToDate } from "../../../shared/linkerVersion";

import { createEventCaches } from "./eventDataCaches";

import {
  PointWithEventType,
  processEventListenerLocation,
  EventListenerProcessResult,
  findEventsWithMatchingEntryPoints,
  findEntryPointsForEventType,
  EventWithEntryPoint,
  EventListenerWithFunctionInfo,
  filterResultsByValidHits,
  deriveFakeSessionEventsFromEntryPoints,
  EventListenerProcessResultFound,
  findFallbackReactDomFunctionOutlines,
  EventListenerEvalResult,
} from "./eventListenerProcessing";
import { InteractionEventKind } from "./constants";
import { createReactEventMapper } from "./evaluationMappers";
import { Errors, isProtocolError } from "../../../protocol/errors";
import { RDT_ANNOTATION_COMMIT } from "../reactDevtools/reactDevtools";

/** All results from processing the events, including "no hits" */
export interface InteractionEventInfo extends TimeStampedPoint {
  nextEventPoint: TimeStampedPoint;
  eventKind: InteractionEventKind;
  processResult: EventListenerProcessResult;
}

export interface InteractionEventInfoFound extends TimeStampedPoint {
  nextEventPoint: TimeStampedPoint;
  eventKind: InteractionEventKind;
  processResult: EventListenerProcessResultFound;
}

/** Final results, narrowed down to _only_ events with hits */
export interface EventListenerJumpLocationContents {
  listenerPoint: TimeStampedPoint;
  nextEventPoint: TimeStampedPoint;
  eventKind: InteractionEventKind;
  eventListener: EventListenerWithFunctionInfo;
}

export type FinalInteractionEventInfo = EventListenerJumpLocationContents &
  TimeStampedPoint;

async function runReactEventListenersRoutine(routine: Routine, cx: Context) {
  const protocolClient = createProtocolClient(routine.iface, cx);

  const replayClient = new ReplayClient(protocolClient);

  const cachesCollection = createCaches();
  const eventCachesCollection = createEventCaches(cachesCollection);

  const mouseEvents: ReplayMouseEvent[] = [];
  const keyboardEvents: ReplayKeyboardEvent[] = [];

  protocolClient.Session.addMouseEventsListener(entry => {
    mouseEvents.push(...entry.events);
  });
  protocolClient.Session.addKeyboardEventsListener(entry => {
    keyboardEvents.push(...entry.events);
  });

  // We need to load the sources and events before we can do anything else.
  // Might as well load those all in parallel
  const [
    eventCounts,
    sourcesById,
    recordingTarget,
    sessionEndpoint,
    buildId,
    hasReactCommitAnnotations,
  ] = await Promise.all([
    eventCachesCollection.eventCountsCache.readAsync(replayClient, null),
    cachesCollection.sourcesByIdCache.readAsync(replayClient),
    cachesCollection.recordingTargetCache.readAsync(replayClient),
    replayClient.getSessionEndpoint(replayClient.getSessionId()!),
    replayClient.getBuildId(),
    replayClient.hasAnnotationKind(RDT_ANNOTATION_COMMIT),
    protocolClient.Session.findMouseEvents({}),
    protocolClient.Session.findKeyboardEvents({}),
  ]);

  const buildMetadata = parseBuildIdComponents(buildId)!;
  const { runtime, date: dateString } = buildMetadata;

  const canUseSharedProcesses = canUseSharedProcessesForEvaluations(runtime, dateString);

  // We only care about click ("mousedown") and keypress events
  const clickEvents = mouseEvents.filter(
    event => event.kind === "mousedown"
  ) as PointWithEventType[];
  const keypressEvents = keyboardEvents.filter(
    event => event.kind === "keypress"
  ) as PointWithEventType[];

  const searchableEventTypes: InteractionEventKind[] = ["keypress", "mousedown"];

  const eventsForSearchableEventTypes: Record<
    InteractionEventKind,
    PointWithEventType[]
  > = {
    mousedown: clickEvents,
    keypress: keypressEvents,
  };

  const hasAnyReactDomSources = Object.values(sourcesById).some(source =>
    source?.url?.includes("react-dom.")
  );

  let fallbackReactDomFunctionOutlines: FunctionOutline[] = [];

  if (!hasAnyReactDomSources && hasReactCommitAnnotations) {
    // We can see that React ran, but we don't know what file it's in.
    // It's possible that React is in a vendor bundle, without sourcemaps.
    // Use function outlines to figure out where, for filtering usage.
    fallbackReactDomFunctionOutlines = await findFallbackReactDomFunctionOutlines(
      cachesCollection,
      replayClient,
      sourcesById
    );
  }

  const clickAndKeypressResults = await Promise.all(
    searchableEventTypes.map(async eventType => {
      const sessionEvents = eventsForSearchableEventTypes[eventType];

      // This is a relatively cheap call to `Session.findPoints` to find
      // all JS event listener calls that match the given event type.
      const entryPoints = await findEntryPointsForEventType(
        eventCachesCollection,
        replayClient,
        eventType,
        recordingTarget,
        eventCounts,
        sessionEndpoint
      );

      let eventsToProcess = sessionEvents;

      if (sessionEvents.length === 0 && entryPoints.length > 0) {
        // Our `Session.find*Events` API returned 0 results, but
        // there _are_ hits of this type in the recording.
        // This is likely a Cypress test. Cypress fakes events,
        // so they show up in the recording, but they don't get
        // handled by the browser's actual input logic.
        // We can try to derive what the original session events
        // _would_ have looked like, by looking at the actual JS
        // event objects.  These have `timeStamp` and `type` fields
        // we can use to determine how many session events we'd have.
        eventsToProcess = await deriveFakeSessionEventsFromEntryPoints(
          eventType,
          entryPoints,
          sourcesById,
          canUseSharedProcesses,
          routine,
          cx
        );
      }

      eventsToProcess.sort(compareTimeStampedPoints);

      // Once we have all the entry points, we can correlate them with
      // the user interaction events based on execution points,
      // and filter it down to just events that had any listener run.
      const eventsWithHits = findEventsWithMatchingEntryPoints(
        eventsToProcess,
        entryPoints,
        sourcesById,
        sessionEndpoint,
        fallbackReactDomFunctionOutlines
      );

      // The original recorded session events occur before any actual JS runs.
      // We need to map between the original session points and the
      // later event listener hit points.
      const eventsByEntryPointPoint: Record<string, EventWithEntryPoint> = {};
      const listenerHitPointsByOriginalEventPoint: Record<string, TimeStampedPoint> = {};

      for (const e of eventsWithHits) {
        eventsByEntryPointPoint[e.entryPoint.point] = e;
        listenerHitPointsByOriginalEventPoint[e.event.point] = {
          point: e.event.point,
          time: e.event.time,
        };
      }

      const reactPropEventMapperResults: EventListenerEvalResult[] = [];

      await routine.runEvaluation(
        {
          points: eventsWithHits.map(e => e.entryPoint.point),
          expression: createReactEventMapper(eventType),
          // Evaluate in the top frame
          frameIndex: 0,
          // Run the eval faster if the runtime supports it
          shareProcesses: canUseSharedProcesses,
          // Include nested object previews as part of the pause data,
          // so that we can synchronously use those during processing
          // without needing to do further API calls at a given pause.
          fullReturnedPropertyPreview: true,
          onResult: ({ point, pauseId, failed, returned, exception, data }) => {
            if (failed) {
              cx.logger.debug("ReactEventEvalFailed", {
                returned,
                exception,
                data,
              });
              throw new RoutineError("REACT_EVENT_EVAL_FAILED", {
                point: point.point,
              });
            }
            if (!returned) {
              cx.logger.debug("ReactEventEvalException", {
                exception,
                data,
              });
              throw new RoutineError("REACT_EVENT_EVAL_EXCEPTION", {
                point: point.point,
              });
            }

            // `onResult` needs to be synchronous - just save the results for later async processing
            reactPropEventMapperResults.push({
              point: point.point,
              pauseId,
              value: returned,
              data,
            });
          },
        },
        cx
      );

      reactPropEventMapperResults.sort((a, b) =>
        compareExecutionPoints(a.point, b.point)
      );
      // Once we have the React prop evaluation results for each of the event
      // listener hit points, we can process them in parallel.
      const processedResults: InteractionEventInfo[] = await Promise.all(
        reactPropEventMapperResults.map(async evalResult => {
          // We either have a hit with formatted listener function details, or no hit
          const processResult = await processEventListenerLocation(
            replayClient,
            cachesCollection,
            evalResult,
            eventsByEntryPointPoint,
            sourcesById,
            eventType
          );

          const eventWithEntryPoint = eventsByEntryPointPoint[evalResult.point];

          return {
            // Differentiate between the `Session.find*Events" point...
            point: eventWithEntryPoint.event.point,
            time: eventWithEntryPoint.event.time,
            // And the time that the _next_ event of this type occurs.
            // Note that we don't know for sure the time the
            // listener itself ran - that will be determined next.
            nextEventPoint: eventWithEntryPoint.nextEventPoint,
            eventKind: eventType,
            processResult,
          };
        })
      );

      return processedResults;
    })
  );

  const allProcessedResults = clickAndKeypressResults
    .flat()
    .sort(compareTimeStampedPoints);

  // We only need to save annotations for points that had an actual
  // listener hit. The UI can assume that there are no hits otherwise.
  const finalResultsWithValidHits = await filterResultsByValidHits(
    replayClient,
    allProcessedResults,
    sourcesById,
    cx
  );

  for (const { point, time, ...contents } of finalResultsWithValidHits) {
    const annotationContents: EventListenerJumpLocationContents = contents;

    const annotation: Annotation = {
      point,
      time,
      kind: "event-listeners-jump-location",
      contents: JSON.stringify(annotationContents),
    };

    cx.logger.debug("BackendEventListener", { point, time, ...contents });
    routine.addAnnotation(annotation);
  }
}

function canUseSharedProcessesForEvaluations(runtime: string, dateString: string) {
  let canUseSharedProcesses = false;

  if (runtime === "chromium") {
    const date = buildDateStringToDate(dateString);

    // Shared Processes support was added to Chromium in early May
    const requiredMinBuildDate = new Date("2023-05-10");
    canUseSharedProcesses = date >= requiredMinBuildDate;
  }
  return canUseSharedProcesses;
}

export const ReactEventListenersRoutine: RoutineSpec = {
  name: "ReactEventListeners",
  version: 4,
  annotationKinds: ["event-listeners-jump-location"],
  runRoutine: async (routine, cx) => {
    try {
      await runReactEventListenersRoutine(routine, cx);
    } catch (err) {
      // See BAC-3767.
      if (isProtocolError(err, Errors.CommandFailed)) {
        throw new RoutineError("COMMAND_FAILED");
      }
      if (isProtocolError(err, Errors.TimedOut)) {
        throw new RoutineError("COMMAND_TIMED_OUT");
      }

      throw err;
    }
  },
  shouldRun: buildMetadata => {
    const { runtime, date: dateString } = buildMetadata;

    const validRuntime = runtime === "gecko" || runtime === "chromium";
    let recordingIsAfterMinBuildDate = true;

    if (runtime === "chromium") {
      const date = buildDateStringToDate(dateString);

      // Chromium Events support was added at the end of March
      const requiredMinBuildDate = new Date("2023-03-30");
      recordingIsAfterMinBuildDate = date >= requiredMinBuildDate;
    }

    return validRuntime && recordingIsAfterMinBuildDate;
  },
};
