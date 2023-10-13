/* Copyright 2023 Record Replay Inc. */

// React Event Listeners routine event listener processing functions

import {
  ObjectPreview,
  Object as ProtocolObject,
  getSourceOutlineResult,
  Location,
  PointDescription,
  SourceLocation,
  TimeStampedPoint,
  MappedLocation,
  FunctionOutline,
  SameLineSourceLocations,
  Property,
  ClassOutline,
  SourceLocationRange,
  SearchSourceContentsMatch,
  ExecutionPoint,
  PauseId,
  PauseData,
  Value as ProtocolValue,
} from "@replayio/protocol";
import groupBy from "lodash/groupBy";

import { CachesCollection, RecordingTarget } from "../shared/caches/ProtocolDataCaches";
import { ReplayClient, ReplayClientInterface } from "../shared/replayClient";
import {
  getPreferredLocation,
  getSourceIdsByCategory,
  isLocationBefore,
  SourceDetails,
  SourcesById,
  updateMappedLocation,
} from "../shared/sources";
import { compareTimeStampedPoints, isExecutionPointGreaterThan } from "../shared/time";
import { Routine, RoutineError } from "../routine";

import { InteractionEventKind } from "./constants";
import { EventCachesCollection } from "./eventDataCaches";
import {
  FinalInteractionEventInfo,
  InteractionEventInfo,
  InteractionEventInfoFound,
} from "./reactEventListeners";
import { EventCategory } from "../shared/events/eventParsing";
import { Context } from "../../../shared/context";
import { sendToSentry } from "../../../shared/logger";

export interface PointWithEventType extends TimeStampedPoint {
  kind: "keypress" | "mousedown";
}

type EventCategories = "Mouse" | "Keyboard";

export interface EventListenerEntry {
  eventType: string;
  categoryKey: EventCategories;
}

export const EVENTS_FOR_RECORDING_TARGET: Partial<
  Record<RecordingTarget, Record<InteractionEventKind, EventListenerEntry>>
> = {
  gecko: {
    mousedown: { categoryKey: "Mouse", eventType: "event.mouse.click" },
    keypress: { categoryKey: "Keyboard", eventType: "event.keyboard.keypress" },
  },
  chromium: {
    mousedown: { categoryKey: "Mouse", eventType: "click" },
    keypress: { categoryKey: "Keyboard", eventType: "keypress" },
  },
};

export interface EventWithEntryPoint {
  event: PointWithEventType;
  entryPoint: PointDescription;
  nextEventPoint: TimeStampedPoint;
}

export type EventListenerProcessResultNoHits = { type: "no_hits" };
export type EventListenerProcessResultFound = {
  type: "found";
  eventListener: EventListenerWithFunctionInfo;
};
export type EventListenerProcessResultNotLoaded = { type: "not_loaded" };

export type EventListenerProcessResult =
  | EventListenerProcessResultNoHits
  | EventListenerProcessResultFound
  | EventListenerProcessResultNotLoaded;

export type FunctionPreview = {
  functionName?: string;
  functionLocation: MappedLocation;
  functionParameterNames?: string[] | undefined;
  prototypeId?: string;
  properties?: Property[];
};

export interface EventListenerWithFunctionInfo {
  type: string;
  functionName: string;
  locationUrl?: string;
  location: Location;
  firstBreakablePosition: Location;
  functionParameterNames: string[];
  framework?: string;
  classComponentName?: string;
}

export type FormattedEventListener = EventListenerWithFunctionInfo & {
  sourceDetails?: SourceDetails;
};

export type FunctionWithPreview = Omit<ProtocolObject, "preview"> & {
  preview: FunctionPreview;
};

// TS magic: https://stackoverflow.com/a/57837897/62937
type DeepRequired<T, P extends string[]> = T extends object
  ? Omit<T, Extract<keyof T, P[0]>> &
      Required<
        {
          [K in Extract<keyof T, P[0]>]: NonNullable<DeepRequired<T[K], ShiftUnion<P>>>;
        }
      >
  : T;

// Analogues to array.prototype.shift
export type Shift<T extends any[]> = ((...t: T) => any) extends (
  first: any,
  ...rest: infer Rest
) => any
  ? Rest
  : never;

// use a distributed conditional type here
type ShiftUnion<T> = T extends any[] ? Shift<T> : never;

export type NodeWithPreview = DeepRequired<
  ProtocolObject,
  ["preview", "node"] | ["preview", "getterValues"]
>;

export const isFunctionPreview = (obj?: ObjectPreview): obj is FunctionPreview => {
  return !!obj && "functionName" in obj && "functionLocation" in obj;
};

export const isFunctionWithPreview = (
  obj: ProtocolObject
): obj is FunctionWithPreview => {
  return (
    (obj.className === "Function" || obj.className === "AsyncFunction") &&
    isFunctionPreview(obj.preview)
  );
};

// For the initial "find the first hit" checks,
// we _don't_ want to exclude `react-dom`, because we
// need to run the evaluation to see if there's a potential
// prop that ran.
export const USER_INTERACTION_IGNORABLE_URLS = [
  // _Never_ treat Cypress events as user interactions
  "__cypress/runner/",
  // or some Google Accounts thing
  "accounts.google.com/gsi/client",
];

// However, for final "found this source" checks, we _do_
// want to exclude React, CodeSandbox, etc
export const IGNORABLE_PARTIAL_SOURCE_URLS = [
  // Don't jump into React internals
  "react-dom.",
  // or CodeSandbox
  "webpack:///src/sandbox/",
  "webpack:///sandpack-core/",
  "webpack:////home/circleci/codesandbox-client",
  // or Cypress
  "__cypress/runner/",
  // or some Google Accounts thing
  "accounts.google.com/gsi/client",
];

const reIsJsSourceFile = /(js|ts)x?(\?[\w\d]+)*$/;

export function shouldIgnoreEventFromSource(
  sourceDetails?: SourceDetails,
  ignorableURLS = IGNORABLE_PARTIAL_SOURCE_URLS
) {
  const url = sourceDetails?.url ?? "";

  // Ignore sources that aren't displayed in the sources tree,
  // such as index sources, Playwright-injected internal logic, etc.
  if (sourceDetails?.kind === "scriptSource" && !reIsJsSourceFile.test(url)) {
    return true;
  }

  return ignorableURLS.some(partialUrl => url.includes(partialUrl));
}

export async function findEntryPointsForEventType(
  eventCachesCollection: EventCachesCollection,
  replayClient: ReplayClientInterface,
  eventType: InteractionEventKind,
  recordingTarget: RecordingTarget,
  eventCounts: EventCategory[],
  sessionEndpoint: TimeStampedPoint
) {
  const initialEventType = EVENTS_FOR_RECORDING_TARGET[recordingTarget]?.[eventType];

  if (!initialEventType) {
    return [];
  }
  const eventTypesToQuery: string[] = [];

  if (recordingTarget === "gecko") {
    // For Firefox, we can use that event string as-is
    eventTypesToQuery.push(initialEventType.eventType);
  } else if (recordingTarget === "chromium") {
    // Now we get to do this the hard way.
    // Chromium sends back a bunch of different types of events.
    // For example, a "click" event could actually be `"click,DIV"`,
    // `"click,BUTTON"`, `"click,BODY"`, etc.
    // We apparently need to add _all_ of those to this analysis for it to work.

    const categoryEntry = eventCounts.find(
      e => e.category === initialEventType.categoryKey
    );
    if (!categoryEntry) {
      return [];
    }
    const eventsForType = categoryEntry.events.find(
      e => e.label === initialEventType.eventType
    );

    if (!eventsForType) {
      return [];
    }

    // If there were no hits, this array won't exist
    const { rawEventTypes = [] } = eventsForType;
    eventTypesToQuery.push(...rawEventTypes);
  }

  // Read all events of these types from the entire recording.
  const entryPoints = await eventCachesCollection.eventPointsCache.readAsync(
    "0",
    sessionEndpoint.point,
    replayClient,
    eventTypesToQuery
  );
  entryPoints.sort(compareTimeStampedPoints);

  return entryPoints;
}

export function findEventsWithMatchingEntryPoints(
  events: PointWithEventType[],
  entryPoints: PointDescription[],
  sourcesById: SourcesById,
  sessionEndpoint: TimeStampedPoint,
  fallbackReactDomFunctionOutlines: FunctionOutline[]
) {
  interface EventEntryPointsAndBound {
    entryPoints: PointDescription[];
    nextEventPoint: TimeStampedPoint;
  }

  const entryPointsByEvent: Map<PointWithEventType, EventEntryPointsAndBound> = new Map();

  // We can group any event listener entry hits based on
  // the point of the event that triggered them and the
  // next event of the same type.  In other words,
  // given click events A and B, any click event listener
  // hits between A and B should have been triggered by A.
  // This should be much more consistent than doing timestamp
  // comparisons, which could be incorrect given the
  // inconsistencies in our backend timestamps.

  let currentEntryPointIndex = 0;

  for (const [index, event] of events.entries()) {
    const nextEventPoint: TimeStampedPoint = events[index + 1] ?? sessionEndpoint;
    const entryPointsForThisEvent: PointDescription[] = [];

    // Pull entry point hits off the list until we hit the next event,
    // by carefully iterating over it as a pseudo-queue.
    for (; currentEntryPointIndex < entryPoints.length; currentEntryPointIndex++) {
      const entryPoint = entryPoints[currentEntryPointIndex];

      // We should stop adding entry points to _this_ event
      // as soon as we see one that is after or identical to
      // the execution point of the _next_ event
      const entryPointIsPartOfNextEvent =
        isExecutionPointGreaterThan(entryPoint.point, nextEventPoint.point) ||
        entryPoint.point === nextEventPoint.point;

      if (entryPointIsPartOfNextEvent) {
        break;
      }

      entryPointsForThisEvent.push(entryPoint);
    }

    entryPointsByEvent.set(event, {
      entryPoints: entryPointsForThisEvent,
      nextEventPoint,
    });
  }

  const eventsWithMatchingEntryPoints: EventWithEntryPoint[] = [];

  for (const [event, eventRelations] of entryPointsByEvent.entries()) {
    // Now that we have all the entry points for this event,
    // we need to find the first one that's actually useful.
    const firstSuitableHandledEvent = eventRelations.entryPoints.find(ep => {
      if (ep.frame?.length) {
        const preferredLocation = getPreferredLocation(sourcesById, ep.frame);
        const matchingSource = sourcesById[preferredLocation!.sourceId];

        // Find the first event that seems useful to jump to
        let shouldIgnore = shouldIgnoreEventFromSource(
          matchingSource,
          USER_INTERACTION_IGNORABLE_URLS
        );

        if (
          !shouldIgnore &&
          preferredLocation &&
          fallbackReactDomFunctionOutlines.length > 0
        ) {
          // we didn't exclude this based on URL, but there's a chance
          // ReactDOM is in a vendor bundle or similar.
          // Check to see if this is inside ReactDOM's impl.
          const isInsideReactDom = fallbackReactDomFunctionOutlines.some(outline =>
            isNestedInside(
              { begin: preferredLocation, end: preferredLocation },
              outline.location
            )
          );
          shouldIgnore = isInsideReactDom;
        }

        return !shouldIgnore;
      }
    });

    if (firstSuitableHandledEvent) {
      // Assuming we actually found a useful entry point,
      // add these to the list for further analysis.
      eventsWithMatchingEntryPoints.push({
        event,
        entryPoint: firstSuitableHandledEvent,
        nextEventPoint: eventRelations.nextEventPoint,
      });
    }
  }

  return eventsWithMatchingEntryPoints;
}

export const formatEventListener = async (
  replayClient: ReplayClientInterface,
  type: InteractionEventKind,
  fnPreview: FunctionPreview,
  sourcesById: SourcesById,
  cachesCollection: CachesCollection,
  framework?: string
): Promise<FormattedEventListener | undefined> => {
  const { functionLocation } = fnPreview;
  updateMappedLocation(sourcesById, functionLocation);

  const location = getPreferredLocation(sourcesById, functionLocation);

  if (!location) {
    return;
  }

  const sourceDetails = sourcesById[location.sourceId];
  if (!sourceDetails) {
    return;
  }
  const locationUrl = sourceDetails.url;

  // See if we can get any better details from the parsed source outline
  const symbols = await cachesCollection.sourceOutlineCache.readAsync(
    replayClient,
    location.sourceId
  );

  const functionOutline = findFunctionOutlineForLocation(location, symbols);

  if (!functionOutline) {
    return;
  }

  if (!functionOutline?.breakpointLocation) {
    // The backend _should_ give us a breakpoint location for this function.
    // But, I'm seeing some cases where it doesn't.
    // Figure that out for ourselves the hard way so we can use this
    // found function and continue processing.
    const [
      ,
      breakablePositionsByLine,
    ] = await cachesCollection.breakpointPositionsCache.readAsync(
      replayClient,
      location.sourceId
    );

    // Use the function outline to find the first breakable position inside
    const nextBreakablePosition = findFirstBreakablePositionForFunction(
      location.sourceId,
      functionOutline,
      breakablePositionsByLine
    );

    if (!nextBreakablePosition) {
      return;
    }

    functionOutline.breakpointLocation = nextBreakablePosition;
  }

  const functionName = functionOutline.name!;
  const functionParameterNames = functionOutline.parameters;

  const possibleMatchingClassDefinition = findClassOutlineForLocation(location, symbols);

  return {
    type,
    sourceDetails,
    location,
    locationUrl,
    firstBreakablePosition: {
      sourceId: sourceDetails?.id,
      ...functionOutline.breakpointLocation,
    },
    functionName: functionName || "Anonymous",
    functionParameterNames,
    framework,
    classComponentName: possibleMatchingClassDefinition?.name,
  };
};

export function findFirstBreakablePositionForFunction(
  sourceId: string,
  functionOutline: FunctionOutline,
  breakablePositionsByLine: Map<number, SameLineSourceLocations>
) {
  const nearestLines: SameLineSourceLocations[] = [];
  const { begin, end } = functionOutline.location;
  for (let lineToCheck = begin.line; lineToCheck <= end.line; lineToCheck++) {
    const linePositions = breakablePositionsByLine.get(lineToCheck);
    if (linePositions) {
      nearestLines.push(linePositions);
    }
  }

  const positionsAsLocations: Location[] = nearestLines.flatMap(line => {
    return line.columns.map(column => {
      return {
        sourceId,
        line: line.line,
        column,
      };
    });
  });

  // We _hope_ that the first breakable position _after_ this function declaration is the first
  // position _inside_ the function itself, either a later column on the same line or on the next line.
  const nextBreakablePosition = positionsAsLocations.find(
    p => isLocationBefore(begin, p) && isLocationBefore(p, end)
  );
  return nextBreakablePosition;
}

export function findFunctionOutlineForLocation(
  location: SourceLocation,
  sourceOutline: getSourceOutlineResult
): FunctionOutline | undefined {
  let foundFunctionOutline: FunctionOutline | undefined = undefined;
  let foundFunctionBegin: SourceLocation | undefined;

  for (const functionOutline of sourceOutline.functions) {
    const functionBegin = functionOutline.location.begin;
    const functionEnd = functionOutline.location.end;

    const functionIsBeforeLocation = isLocationBefore(functionBegin, location);
    // We sometimes seem to have a column off by one mismatch
    // between preview function locations and source outline
    // function locations, so we'll allow that.
    const functionBeginLooksSameLineAndCloseEnough =
      functionBegin.line === location.line &&
      Math.abs(functionBegin.column - location.column) <= 1;
    const locationIsBeforeEnd = isLocationBefore(location, functionEnd);

    const functionIsCloserThanFoundFunction =
      !foundFunctionBegin || isLocationBefore(foundFunctionBegin, functionBegin);

    const isMatch =
      (functionIsBeforeLocation || functionBeginLooksSameLineAndCloseEnough) &&
      locationIsBeforeEnd &&
      functionIsCloserThanFoundFunction;

    if (isMatch) {
      foundFunctionBegin = functionBegin;
      foundFunctionOutline = functionOutline;
    }
  }
  return foundFunctionOutline;
}

export function findClassOutlineForLocation(
  location: SourceLocation,
  sourceOutline: getSourceOutlineResult
): ClassOutline | undefined {
  let foundClassOutline: ClassOutline | undefined = undefined;
  let foundClassBegin: SourceLocation | undefined;

  for (const classOutline of sourceOutline.classes) {
    const classBegin = classOutline.location.begin;
    const classEnd = classOutline.location.end;

    const functionIsBeforeLocation = isLocationBefore(classBegin, location);
    const locationIsBeforeEnd = isLocationBefore(location, classEnd);

    const functionIsCloserThanFoundFunction =
      !foundClassBegin || isLocationBefore(foundClassBegin, classBegin);

    const isMatch =
      functionIsBeforeLocation &&
      locationIsBeforeEnd &&
      functionIsCloserThanFoundFunction;

    if (isMatch) {
      foundClassBegin = classBegin;
      foundClassOutline = classOutline;
    }
  }
  return foundClassOutline;
}

export function isNestedInside(child: SourceLocationRange, parent: SourceLocationRange) {
  const startsBefore =
    parent.begin.line < child.begin.line ||
    (parent.begin.line === child.begin.line && parent.begin.column <= child.begin.column);
  const endsAfter =
    parent.end.line > child.end.line ||
    (parent.end.line === child.end.line && parent.end.column >= child.end.column);

  return startsBefore && endsAfter;
}

// Check for all the functions before the fnIndex in the array
// and find the one that wraps the function at fnIndex
export function findFunctionParent(functions: FunctionOutline[], fnIndex: number) {
  for (let i = fnIndex - 1; i >= 0; i--) {
    const maybeParentFn = functions[i];

    if (isNestedInside(functions[fnIndex].location, maybeParentFn.location)) {
      return maybeParentFn;
    }
  }

  return null;
}

export async function findFallbackReactDomFunctionOutlines(
  cachesCollection: CachesCollection,
  replayClient: ReplayClientInterface,
  sourcesById: SourcesById
): Promise<FunctionOutline[]> {
  const fallbackReactDomFunctionOutlines: FunctionOutline[] = [];

  const { sourceIdsWithNodeModules } = getSourceIdsByCategory(sourcesById);
  const finalMatches: SearchSourceContentsMatch[] = [];

  // This is slower than I'd like, but it's at least reliable.
  // There could be multiple copies of React in the recording too.
  await replayClient.searchSources(
    {
      // This is the magic error code that's in `scheduleUpdateOnFiber`
      query: "(185)",
      sourceIds: sourceIdsWithNodeModules,
    },
    matches => {
      finalMatches.push(...matches);
    }
  );

  if (finalMatches.length > 0) {
    await Promise.all(
      finalMatches.map(async match => {
        // There's a good chance that ReactDOM is in a vendor bundle,
        // and the contents are inside some Webpack-ified
        // module function wrapper.
        // See if we can find a function that looks like
        // `scheduleUpdateOnFiber`, and go up one level.
        // This lets us eliminate any event listener hits
        // that appear to be inside of `react-dom` itself.
        // This is _highly_ dependent on ReactDOM compiled output,
        // but it works in the examples I'm using.
        const sourceOutlines = await cachesCollection.sourceOutlineCache.readAsync(
          replayClient,
          match.location.sourceId
        );

        const scheduleUpdateFunction = findFunctionOutlineForLocation(
          match.location,
          sourceOutlines
        );

        if (scheduleUpdateFunction) {
          const index = sourceOutlines.functions.indexOf(scheduleUpdateFunction);
          const parentOutline = findFunctionParent(sourceOutlines.functions, index);

          if (parentOutline) {
            fallbackReactDomFunctionOutlines.push(parentOutline);
          }
        }
      })
    );
  }

  return fallbackReactDomFunctionOutlines;
}

export type EventListenerEvalResult = {
  point: ExecutionPoint;
  pauseId: PauseId;
  value: ProtocolValue;
  data: PauseData;
};

export async function processEventListenerLocation(
  replayClient: ReplayClient,
  cachesCollection: CachesCollection,
  evalResult: EventListenerEvalResult,
  eventsByEntryPointPoint: Record<string, EventWithEntryPoint>,
  sourcesById: SourcesById,
  eventType: InteractionEventKind
): Promise<EventListenerProcessResult> {
  const { point, value, data } = evalResult;
  // The backend _currently_ uses an identical fake pause ID.
  // Just use the point string instead for now.
  cachesCollection.cachePauseData(replayClient, evalResult.pauseId, data);
  const obj = cachesCollection.getCachedObject(evalResult.pauseId, value.object!);
  let functionPreview: FunctionPreview | undefined = undefined;
  let framework: string | undefined = undefined;

  // The evaluation _may_ return `{handlerProp, fieldName}` if
  // it found a likely React event handler prop.
  // If no event was found at all, we'd have no object
  // and skip over these checks entirely.
  const handlerProp = obj?.preview?.properties?.find(p => p.name === "handlerProp");
  const fieldName = obj?.preview?.properties?.find(p => p.name === "fieldName");

  if (handlerProp && fieldName) {
    // If it did find a React prop function, get its
    // preview and format it so we know the preferred location.
    const functionInstanceDetails = cachesCollection.getCachedObject(
      evalResult.pauseId,
      handlerProp.object!
    );

    if (functionInstanceDetails && isFunctionPreview(functionInstanceDetails.preview)) {
      functionPreview = functionInstanceDetails.preview;
      framework = "react";
    }
  }

  if (!functionPreview) {
    const entryPoint = eventsByEntryPointPoint[point];
    if (entryPoint.entryPoint.frame) {
      // Otherwise, use the location from the actual JS event handler.
      functionPreview = {
        functionLocation: entryPoint.entryPoint.frame,
      };
    }
  }

  if (!functionPreview) {
    return { type: "no_hits" };
  }

  let formattedEventListener:
    | FormattedEventListener
    | undefined = await formatEventListener(
    replayClient,
    eventType,
    functionPreview,
    sourcesById,
    cachesCollection,
    framework
  );

  if (!formattedEventListener) {
    return { type: "no_hits" };
  }

  const { sourceDetails } = formattedEventListener;

  if (shouldIgnoreEventFromSource(sourceDetails)) {
    // Intentionally _don't_ jump to into specific ignorable libraries, like React
    formattedEventListener = undefined;
  }

  let result: EventListenerProcessResult = { type: "no_hits" };

  if (formattedEventListener) {
    // omit the `sourceDetails` field, no need to persist that
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { sourceDetails, ...eventListener } = formattedEventListener;
    result = {
      type: "found",
      eventListener,
    };
  }

  return result;
}

export function locationToString(location: Location) {
  return `${location.sourceId}:${location.line}:${location.column}`;
}

function isFoundResult(info: InteractionEventInfo): info is InteractionEventInfoFound {
  return info.processResult.type === "found";
}

export async function filterResultsByValidHits(
  replayClient: ReplayClientInterface,
  allProcessedResults: InteractionEventInfo[],
  sourcesById: SourcesById,
  cx: Context
): Promise<FinalInteractionEventInfo[]> {
  // We know the list of functions that we think were used.
  // JS event listeners were _definitely_ hit, because those
  // were pulled directly from the entry point stack frames.
  // But, our heuristics around React props _might_ have produced
  // some false positives. We can confirm those by getting hit points
  // for each of those functions and seeing if they actually got hit
  // during the event's time range.

  // We can safely narrow this to just results where we found a function
  const foundResults = allProcessedResults.filter(isFoundResult);

  const finalResultsWithValidHits: FinalInteractionEventInfo[] = [];

  await Promise.all(
    foundResults.map(async result => {
      const { eventListener } = result.processResult;
      const { firstBreakablePosition } = eventListener;

      const source = sourcesById[firstBreakablePosition.sourceId]!;
      // We need to search for hit points for _all_ corresponding sources,
      // especially since the file may have many duplicates due to multiple tests
      // being loaded in the same recording.

      const correspondingLocations: Location[] = source.correspondingSourceIds.map(
        correspondingSourceId => {
          const correspondingLocation: Location = {
            ...firstBreakablePosition,
            sourceId: correspondingSourceId,
          };
          return correspondingLocation;
        }
      );

      try {
        const hits = await replayClient.findPoints(
          {
            kind: "locations",
            locations: correspondingLocations,
          },
          {
            begin: result.point,
            end: result.nextEventPoint.point,
          }
        );

        if (hits.length === 0) {
          return undefined;
        }

        hits.sort(compareTimeStampedPoints);

        hits.forEach(p => {
          updateMappedLocation(sourcesById, p.frame);
        });

        const hitInEventTimeRange = hits[0];

        // We now know that the function we found _was_ hit during the event's time range.
        finalResultsWithValidHits.push({
          // The main timestamp is the point of the actual click/keypress event
          point: result.point,
          time: result.time,
          eventKind: result.eventKind,
          // We save the point when the found function itself ran,
          // so the UI can jump to that time
          listenerPoint: {
            // Drop the stack frame info so we just have the TimeStampedPoint
            point: hitInEventTimeRange.point,
            time: hitInEventTimeRange.time,
          },
          // We store the function details so we know the source location
          // and the function name
          eventListener: result.processResult.eventListener,
          // And we tack on the timestamp of the next event of the same kind
          // so that we can double-check ranges if necessary.
          nextEventPoint: result.nextEventPoint,
        });
      } catch (err) {
        // Log this, but don't crash.
        // Some results are better than none.
        cx.logger.error("EventListenersFindPointsError", {
          [sendToSentry]: true,
          error: err,
        });
      }
    })
  );

  finalResultsWithValidHits.sort(compareTimeStampedPoints);

  return finalResultsWithValidHits;
}

export async function deriveFakeSessionEventsFromEntryPoints(
  eventType: InteractionEventKind,
  entryPoints: PointDescription[],
  sourcesById: SourcesById,
  canUseSharedProcesses: boolean,
  routine: Routine,
  cx: Context
): Promise<PointWithEventType[]> {
  // Look up source details for each entry point.
  const entryPointsWithLocations = entryPoints.map(ep => {
    const preferredLocation = getPreferredLocation(sourcesById, ep.frame);
    const matchingSource = sourcesById[preferredLocation!.sourceId]!;
    return {
      point: ep.point,
      time: ep.time,
      location: preferredLocation,
      source: matchingSource,
    };
  });

  // We can ignore any entry points that are from Cypress.
  const nonCypressEntryPoints = entryPointsWithLocations.filter(ep => {
    const shouldIgnore = shouldIgnoreEventFromSource(
      ep.source,
      USER_INTERACTION_IGNORABLE_URLS
    );

    return !shouldIgnore;
  });

  const parsedEvents: (PointWithEventType & { eventTimestamp: number })[] = [];

  // Browsers save the current event object as `window.event`.
  // Events have an `e.timeStamp` field.
  // We can use that to group together all entry point hits that
  // ran in response to the same event.
  // Note that the `e.timeStamp` field will _not_ match up with the
  // `time` fields we have from our various evaluations, as the in-page
  // execution could be very different from the recording playback
  // (reloads, etc).
  await routine.runEvaluation(
    {
      points: nonCypressEntryPoints.map(p => p.point),
      expression: `
            (() => {
              return window.event ? JSON.stringify({
                type: window.event.type,
                timeStamp: window.event.timeStamp
              }) : null;
            })()
          `,
      // Evaluate in the top frame.
      // This really seems to make a difference in whether`window.event` is available?
      frameIndex: 0,
      shareProcesses: canUseSharedProcesses,
      onResult: ({ point, failed, returned, exception, data }, cx) => {
        if (failed) {
          cx.logger.debug("EventListenerProcessingFailed", {
            returned,
            exception,
            data,
          });
          throw new RoutineError("EVENT_LISTENER_PROCESSING_FAILED", {
            point: point.point,
          });
        }
        if (!returned) {
          cx.logger.debug("EventListenerProcessingException", {
            exception,
            data,
          });
          throw new RoutineError("EVENT_LISTENER_PROCESSING_EXCEPTION", {
            point: point.point,
          });
        }

        // `onResult` needs to be synchronous - just save the results for later async processing
        const parsedValue = JSON.parse(returned.value ?? "null");

        if (parsedValue) {
          parsedEvents.push({
            kind: eventType,
            point: point.point,
            time: point.time,
            eventTimestamp: parsedValue.timeStamp,
          });
        }
      },
    },
    cx
  );

  parsedEvents.sort(compareTimeStampedPoints);

  const eventsByEventTimestamp = groupBy(parsedEvents, p => p.eventTimestamp);

  // Synthesize fake session events by reusing the point and time
  // of the first entry point that ran in response to each event.
  const finalEvents: PointWithEventType[] = Object.values(eventsByEventTimestamp).map(
    e => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { eventTimestamp, ...finalEvent } = e[0];
      return finalEvent;
    }
  );

  // Have to ensure these are sorted for proper diffing/grouping later
  finalEvents.sort(compareTimeStampedPoints);

  return finalEvents;
}
