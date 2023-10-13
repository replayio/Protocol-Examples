/* Copyright 2023 Record Replay Inc. */

import {
  BreakpointId,
  ContentType,
  Result as EvaluationResult,
  EventHandlerType,
  ExecutionPoint,
  FocusWindowRequest,
  FrameId,
  FunctionMatch,
  KeyboardEvent,
  loadedRegions as LoadedRegions,
  Location,
  MappedLocation,
  Message,
  MouseEvent,
  NavigationEvent,
  ObjectId,
  ObjectPreviewLevel,
  PauseData,
  PauseId,
  PointDescription,
  PointLimits,
  PointRange,
  PointSelector,
  getPointsBoundingTimeResult as PointsBoundingTime,
  RecordingId,
  Result,
  RunEvaluationResult,
  SameLineSourceLocations,
  ScopeId,
  SearchSourceContentsMatch,
  SessionId,
  Source,
  SourceId,
  SourceLocation,
  TimeStampedPoint,
  TimeStampedPointRange,
  VariableMapping,
  createPauseResult,
  getAllFramesResult,
  getExceptionValueResult,
  getScopeResult,
  getSourceOutlineResult,
  getTopFrameResult,
  keyboardEvents,
  navigationEvents,
  repaintGraphicsResult,
  ProtocolClient,
  searchSourceContentsMatches,
  PointPageLimits,
  runEvaluationResults,
  sourceContentsInfo,
  sourceContentsChunk,
  findPointsResults,
  functionsMatches,
  newSources,
} from "@replayio/protocol";

import throttle from "lodash/throttle";
import uniqueId from "lodash/uniqueId";

import { defer } from "../../../shared/promise";
import { assert } from "./utils";

import { binarySearch, waitForTime, ProtocolError, commandError } from "./utils";
import { getCorrespondingSourceIds, SourcesById } from "./sources";

// import { ProtocolError, commandError, isCommandError } from "shared/utils/error";
import {
  compareExecutionPoints as compareNumericStrings,
  isTimeInRegions,
  areRangesEqual,
} from "./time";

export type LogEntry = {
  args: any[];
  isAsync: boolean;
  method: string;
  result: any;
};

export type ColumnHits = {
  hits: number;
  location: SourceLocation;
};

export type LineHitCounts = {
  count: number;
  firstBreakableColumnIndex: number;
};
export type LineNumberToHitCountMap = Map<number, LineHitCounts>;

export type Events = {
  keyboardEvents: KeyboardEvent[];
  mouseEvents: MouseEvent[];
  navigationEvents: NavigationEvent[];
};

export const POINT_BEHAVIOR_ENABLED = "enabled";
export const POINT_BEHAVIOR_DISABLED = "disabled";
export const POINT_BEHAVIOR_DISABLED_TEMPORARILY = "disabled-temporarily";

export type POINT_BEHAVIOR =
  | typeof POINT_BEHAVIOR_ENABLED
  | typeof POINT_BEHAVIOR_DISABLED
  | typeof POINT_BEHAVIOR_DISABLED_TEMPORARILY;

export type PartialUser = {
  id: string;
  name: string | null;
  picture: string | null;
};

export type PointKey = string;
export type Badge = "blue" | "green" | "orange" | "purple" | "unicorn" | "yellow";

// Points are saved to GraphQL.
// They can be viewed by all users who have access to a recording.
// They can only be edited or deleted by the user who created them.
//
// Note that Points are only saved to GraphQL for authenticated users.
// They are also saved to IndexedDB to support unauthenticated users.
export type Point = {
  // This a client-assigned value is used as the primary key on the server.
  // It exists to simplify equality checks and PointBehavior mapping.
  key: PointKey;

  // These attributes are fixed after Point creation
  createdAt: Date;
  location: Location;
  recordingId: RecordingId;
  user: PartialUser | null;

  // These attributes are editable, although only by the Point's owner
  badge: Badge | null;
  condition: string | null;
  content: string;
};

// Point behaviors are saved to IndexedDB.
// (They are remembered between sessions but are not shared with other users.)
// They control a given point behaves locally (e.g. does it log to the console)
// Behaviors are modifiable by everyone (regardless of who created a point).
export type PointBehavior = {
  key: PointKey;
  shouldBreak: POINT_BEHAVIOR;
  shouldLog: POINT_BEHAVIOR;
};

export type ReplayClientEvents = "loadedRegionsChange";

export type HitPointStatus =
  | "complete"
  | "too-many-points-to-find"
  | "too-many-points-to-run-analysis"
  | "unknown-error";

export type HitPointsAndStatusTuple = [
  points: TimeStampedPoint[],
  status: HitPointStatus
];
export interface SourceLocationRange {
  start: SourceLocation;
  end: SourceLocation;
}

type EventListenerCallback = (...args: any[]) => any;

export interface ReplayClientInterface {
  protocolClient: ProtocolClient;
  setSourcesById(sourcesById: SourcesById): void;
  loadedRegions(): LoadedRegions | null;
  addEventListener(type: ReplayClientEvents, handler: EventListenerCallback): void;
  breakpointAdded(location: Location, condition: string | null): Promise<BreakpointId[]>;
  breakpointRemoved(breakpointId: BreakpointId): Promise<void>;
  configure(sessionId: string): void;
  createPause(executionPoint: ExecutionPoint): Promise<createPauseResult>;
  evaluateExpression(
    pauseId: PauseId,
    expression: string,
    frameId: FrameId | null
  ): Promise<EvaluationResult>;
  findKeyboardEvents(onKeyboardEvents: (events: keyboardEvents) => void): Promise<void>;
  findMessages(
    focusRange: TimeStampedPointRange | null
  ): Promise<{
    messages: Message[];
    overflow: boolean;
  }>;
  findNavigationEvents(
    onKeyboardEvents: (events: navigationEvents) => void
  ): Promise<void>;
  findPoints(selector: PointSelector, limits?: PointLimits): Promise<PointDescription[]>;
  findSources(): Promise<Source[]>;
  getAllEventHandlerCounts(range: PointRange | null): Promise<Record<string, number>>;
  getAllFrames(pauseId: PauseId): Promise<getAllFramesResult>;
  getAnnotationKinds(): Promise<string[]>;
  getBreakpointPositions(
    sourceId: SourceId,
    range: SourceLocationRange | null
  ): Promise<SameLineSourceLocations[]>;
  getBuildId(): Promise<string>;
  getCorrespondingLocations(location: Location): Location[];
  getCorrespondingSourceIds(sourceId: SourceId): SourceId[];
  getEventCountForTypes(
    eventTypes: EventHandlerType[],
    focusRange: PointRange | null
  ): Promise<Record<string, number>>;
  getExceptionValue(pauseId: PauseId): Promise<getExceptionValueResult>;
  getFocusWindow(): Promise<TimeStampedPointRange>;
  getFrameSteps(pauseId: PauseId, frameId: FrameId): Promise<PointDescription[]>;
  getMappedLocation(location: Location): Promise<MappedLocation>;
  getObjectWithPreview(
    objectId: ObjectId,
    pauseId: PauseId,
    level?: ObjectPreviewLevel
  ): Promise<PauseData>;
  getObjectProperty(
    objectId: ObjectId,
    pauseId: PauseId,
    propertyName: string
  ): Promise<Result>;
  getPointNearTime(time: number): Promise<TimeStampedPoint>;
  getPointsBoundingTime(time: number): Promise<PointsBoundingTime>;
  getPreferredLocation(locations: Location[]): Location | null;
  getRecordingId(): RecordingId | null;
  getScope(pauseId: PauseId, scopeId: ScopeId): Promise<getScopeResult>;
  getScopeMap(location: Location): Promise<VariableMapping[] | undefined>;
  getSessionEndpoint(sessionId: SessionId): Promise<TimeStampedPoint>;
  getSessionId(): SessionId | undefined;
  getSourceHitCounts(
    sourceId: SourceId,
    locationRange: SourceLocationRange,
    sourceLocations: SameLineSourceLocations[],
    focusRange: PointRange | null
  ): Promise<LineNumberToHitCountMap>;
  getSourceOutline(sourceId: SourceId): Promise<getSourceOutlineResult>;
  getTopFrame(pauseId: PauseId): Promise<getTopFrameResult>;
  hasAnnotationKind(kind: string): Promise<boolean>;
  // initialize(recordingId: string, accessToken: string | null): Promise<SessionId>;
  // isOriginalSource(sourceId: SourceId): boolean;
  // isPrettyPrintedSource(sourceId: SourceId): boolean;
  mapExpressionToGeneratedScope(expression: string, location: Location): Promise<string>;
  requestFocusRange(range: FocusWindowRequest): Promise<TimeStampedPointRange>;
  removeEventListener(type: ReplayClientEvents, handler: EventListenerCallback): void;
  repaintGraphics(pauseId: PauseId): Promise<repaintGraphicsResult>;
  runEvaluation(
    opts: {
      selector: PointSelector;
      expression: string;
      frameIndex?: number;
      fullPropertyPreview?: boolean;
      limits?: PointLimits;
    },
    onResults: (results: RunEvaluationResult[]) => void
  ): Promise<void>;
  searchFunctions(
    opts: {
      query: string;
      sourceIds?: string[];
    },
    onMatches: (matches: FunctionMatch[]) => void
  ): Promise<void>;
  searchSources(
    opts: {
      limit?: number;
      query: string;
      sourceIds?: string[];
    },
    onMatches: (matches: SearchSourceContentsMatch[], didOverflow: boolean) => void
  ): Promise<void>;
  streamSourceContents(
    sourceId: SourceId,
    onSourceContentsInfo: ({
      codeUnitCount,
      contentType,
      lineCount,
      sourceId,
    }: {
      codeUnitCount: number;
      contentType: ContentType;
      lineCount: number;
      sourceId: SourceId;
    }) => void,
    onSourceContentsChunk: ({
      chunk,
      sourceId,
    }: {
      chunk: string;
      sourceId: SourceId;
    }) => void
  ): Promise<void>;
  // waitForLoadedSources(): Promise<void>;
  waitForTimeToBeLoaded(time: number): Promise<void>;
}

export const TOO_MANY_POINTS_TO_FIND = 10_000;

export const MAX_POINTS_TO_FIND = 10_000;
export const MAX_POINTS_TO_RUN_EVALUATION = 200;

const STREAMING_THROTTLE_DURATION = 100;

// TODO How should the client handle concurrent requests?
// Should we force serialization?
// Should we cancel in-flight requests and start new ones?

type GetPreferredLocation = (locations: Location[]) => Location | null;

type LoadedRegionListener = (loadedRegions: LoadedRegions) => void;

export class ReplayClient implements ReplayClientInterface {
  public protocolClient: ProtocolClient;
  private _sourcesById?: SourcesById;
  private _eventHandlers: Map<ReplayClientEvents, EventListenerCallback[]> = new Map();
  private _injectedGetPreferredLocation: GetPreferredLocation | null = null;
  private _loadedRegions: LoadedRegions | null = null;
  private _recordingId: RecordingId | null = null;
  private _sessionId: SessionId | undefined = undefined;

  private sessionWaiter = defer<SessionId>();

  private _listeningForLoadChanges: boolean = false;
  private _loadedRegionsListeners: LoadedRegionListener[] = [];
  private _mostRecentLoadedRegions: LoadedRegions | null = null;

  private nextFindPointsId = 1;
  private nextRunEvaluationId = 1;

  constructor(_protocolClient: ProtocolClient) {
    this.protocolClient = _protocolClient;
  }

  private getSessionIdThrows(): SessionId | undefined {
    const sessionId = this._sessionId;
    // if (sessionId === null) {
    //   throw Error("Invalid session");
    // }
    return sessionId;
  }

  // Configures the client to use an already initialized session iD.
  // This method should be used for apps that use the protocol package directly.
  // Apps that only communicate with the Replay protocol through this client should use the initialize method instead.
  configure(sessionId: string): void {
    this._sessionId = sessionId;
    this.sessionWaiter.resolve(sessionId);
  }

  public setSourcesById(sourcesById: SourcesById) {
    this._sourcesById = sourcesById;
  }

  async waitForSession() {
    // return this.sessionWaiter.promise;
    return this._sessionId;
  }

  async listenForLoadChanges(listener: LoadedRegionListener) {
    this._loadedRegionsListeners.push(listener);

    if (!this._listeningForLoadChanges) {
      this._listeningForLoadChanges = true;

      const sessionId = await this.waitForSession();

      this.protocolClient.Session.addLoadedRegionsListener(
        (loadedRegions: LoadedRegions) => {
          this._mostRecentLoadedRegions = loadedRegions;

          if (areRangesEqual(loadedRegions.indexed, loadedRegions.loading)) {
            assert(
              loadedRegions.loading.length === 1,
              "there should be exactly one initially loaded region"
            );
          }
          this._loadedRegionsListeners.forEach(callback => callback(loadedRegions));
        }
      );

      this.protocolClient.Session.listenForLoadChanges({}, sessionId);
    } else {
      if (this._mostRecentLoadedRegions !== null) {
        listener(this._mostRecentLoadedRegions);
      }
    }
  }

  loadedRegions(): LoadedRegions | null {
    return this._loadedRegions;
  }

  addEventListener(type: ReplayClientEvents, handler: EventListenerCallback): void {
    if (!this._eventHandlers.has(type)) {
      this._eventHandlers.set(type, []);
    }

    const handlers = this._eventHandlers.get(type)!;
    handlers.push(handler);
  }

  async breakpointAdded(
    location: Location,
    condition: string | null
  ): Promise<BreakpointId[]> {
    const sessionId = this.getSessionIdThrows();

    const correspondingLocations = this.getCorrespondingLocations(location);

    const breakpointIds: BreakpointId[] = await Promise.all(
      correspondingLocations.map(async location => {
        const { breakpointId } = await this.protocolClient.Debugger.setBreakpoint(
          {
            condition: condition || undefined,
            location,
          },
          sessionId
        );

        return breakpointId;
      })
    );

    return breakpointIds;
  }

  async breakpointRemoved(breakpointId: BreakpointId): Promise<void> {
    const sessionId = this.getSessionIdThrows();
    await this.protocolClient.Debugger.removeBreakpoint({ breakpointId }, sessionId);
  }

  async getBuildId(): Promise<string> {
    const sessionId = await this.waitForSession();
    const { buildId } = await this.protocolClient.Session.getBuildId({}, sessionId);
    return buildId;
  }

  async createPause(executionPoint: ExecutionPoint): Promise<createPauseResult> {
    const sessionId = this.getSessionIdThrows();

    await this._waitForPointToBeLoaded(executionPoint);

    const response = await this.protocolClient.Session.createPause(
      { point: executionPoint },
      sessionId
    );

    return response;
  }

  async evaluateExpression(
    pauseId: PauseId,
    expression: string,
    frameId: FrameId | null
  ): Promise<EvaluationResult> {
    const sessionId = this.getSessionIdThrows();

    // Edge case handling:
    // User is logging a plan object (e.g. "{...}")
    // This expression will not evaluate correctly unless we wrap parens around it
    if (expression.startsWith("{") && expression.endsWith("}")) {
      expression = `(${expression})`;
    }

    if (frameId === null) {
      const response = await this.protocolClient.Pause.evaluateInGlobal(
        {
          expression,
          pure: false,
        },
        sessionId,
        pauseId
      );
      return response.result;
    } else {
      const response = await this.protocolClient.Pause.evaluateInFrame(
        {
          frameId,
          expression,
          pure: false,
          useOriginalScopes: true,
        },
        sessionId,
        pauseId
      );
      return response.result;
    }
  }

  // Initializes the WebSocket and remote session.
  // This method should be used for apps that only communicate with the Replay protocol through this this.protocolClient.
  // Apps that use the protocol package directly should use the configure method instead.
  // async initialize(
  //   recordingId: RecordingId,
  //   accessToken: string | null
  // ): Promise<SessionId> {
  //   this._recordingId = recordingId;

  //   initProtocolMessagesStore();

  //   const socket = initSocket(this._dispatchURL);
  //   await waitForOpenConnection(socket!);

  //   if (accessToken != null) {
  //     await this.protocolClient.Authentication.setAccessToken({ accessToken });
  //   }

  //   const { sessionId } = await this.protocolClient.Recording.createSession({
  //     recordingId,
  //   });

  //   this._sessionId = sessionId;
  //   this.sessionWaiter.resolve(sessionId);
  //   this._threadFront.setSessionId(sessionId);

  //   return sessionId;
  // }

  async findKeyboardEvents(onKeyboardEvents: (events: keyboardEvents) => void) {
    const sessionId = this.getSessionIdThrows();
    this.protocolClient.Session.addKeyboardEventsListener(onKeyboardEvents);
    await this.protocolClient.Session.findKeyboardEvents({}, sessionId!);
    this.protocolClient.Session.removeKeyboardEventsListener(onKeyboardEvents);
  }

  // Allows legacy app to inject Redux source/location data into the this.protocolClient.
  // TODO [bvaughn] This is a stop-gap; we should move this logic into the new architecture somehow.
  injectGetPreferredLocation(getPreferredLocation: GetPreferredLocation) {
    this._injectedGetPreferredLocation = getPreferredLocation;
  }

  async findMessages(
    focusRange: TimeStampedPointRange | null
  ): Promise<{
    messages: Message[];
    overflow: boolean;
  }> {
    const sessionId = this.getSessionIdThrows();

    if (focusRange !== null) {
      // We *only* care about loaded regions when calling `findMessagesInRange`.
      // Calling `findMessages` is always safe and always returns the console
      // messages for all parts of the recording, regardless of what is
      // currently loading or loaded. The reason we sometimes use
      // `findMessagesInRange` is because `findMessages` can overflow (if the
      // replay contains more than 1,000 console messages). In that case, we
      // might be able to fetch all of the console messages for a particular
      // section by using `findMessagesInRange`, but it requires sending
      // manifests to a running process, so it will only work in loaded regions.

      // It would be better if `findMessagesInRange` either errored when the
      // requested range could not be returned, or returned the boundaries of
      // what it *did* successfully load (see BAC-2536), but right now it will
      // just silently return a subset of messages. Given that we are extra
      // careful here not to to fetch messages in unloaded regions because the
      // result might be invalid (and may get cached by a Suspense caller).
      await this._waitForRangeToBeLoaded(focusRange);

      const response = await this.protocolClient.Console.findMessagesInRange(
        { range: { begin: focusRange.begin.point, end: focusRange.end.point } },
        sessionId
      );

      // Messages aren't guaranteed to arrive sorted, but unsorted messages aren't that useful to work with.
      // So sort them before returning.
      const sortedMessages = response.messages.sort(
        (messageA: Message, messageB: Message) => {
          const pointA = messageA.point.point;
          const pointB = messageB.point.point;
          return compareNumericStrings(pointA, pointB);
        }
      );

      return {
        messages: sortedMessages,
        overflow: response.overflow == true,
      };
    } else {
      const sortedMessages: Message[] = [];

      // TODO This won't work if there are every overlapping requests.
      // Do we need to implement some kind of locking mechanism to ensure only one read is going at a time?
      this.protocolClient.Console.addNewMessageListener(({ message }) => {
        const newMessagePoint = message.point.point;

        // Messages may arrive out of order so let's sort them as we get them.
        let lowIndex = 0;
        let highIndex = sortedMessages.length;
        while (lowIndex < highIndex) {
          const middleIndex = (lowIndex + highIndex) >>> 1;
          const message = sortedMessages[middleIndex];

          if (compareNumericStrings(message.point.point, newMessagePoint)) {
            lowIndex = middleIndex + 1;
          } else {
            highIndex = middleIndex;
          }
        }

        const insertAtIndex = lowIndex;

        sortedMessages.splice(insertAtIndex, 0, message);
      });

      const response = await this.protocolClient.Console.findMessages({}, sessionId);

      this.protocolClient.Console.removeNewMessageListener();

      return {
        messages: sortedMessages,
        overflow: response.overflow == true,
      };
    }
  }

  async findNavigationEvents(onNavigationEvents: (events: navigationEvents) => void) {
    const sessionId = this.getSessionIdThrows();
    this.protocolClient.Session.addNavigationEventsListener(onNavigationEvents);
    await this.protocolClient.Session.findNavigationEvents({}, sessionId!);
    this.protocolClient.Session.removeNavigationEventsListener(onNavigationEvents);
  }

  async findPoints(
    pointSelector: PointSelector,
    pointLimits?: PointPageLimits
  ): Promise<PointDescription[]> {
    const points: PointDescription[] = [];
    const sessionId = this.getSessionIdThrows();
    const findPointsId = String(this.nextFindPointsId++);
    pointLimits = pointLimits ? { ...pointLimits } : {};
    if (!pointLimits.maxCount) {
      pointLimits.maxCount = MAX_POINTS_TO_FIND;
    }

    await this._waitForRangeToBeLoaded(
      pointLimits.begin && pointLimits.end
        ? { begin: pointLimits.begin, end: pointLimits.end }
        : null
    );

    function onPoints(results: findPointsResults) {
      if (results.findPointsId === findPointsId) {
        points.push(...results.points);
      }
    }

    this.protocolClient.Session.addFindPointsResultsListener(onPoints);

    let result;
    try {
      result = await this.protocolClient.Session.findPoints(
        { pointSelector, pointLimits, findPointsId },
        sessionId
      );
    } finally {
      this.protocolClient.Session.removeFindPointsResultsListener(onPoints);
    }

    if (result.nextBegin) {
      throw commandError("Too many points", ProtocolError.TooManyPoints);
    }

    points.sort((a, b) => compareNumericStrings(a.point, b.point));
    return points;
  }

  async findSources(): Promise<Source[]> {
    const sources: Source[] = [];

    await this.waitForSession();

    const sessionId = this.getSessionIdThrows();

    const newSourceListener = (source: Source) => {
      sources.push(source);
    };
    const newSourcesListener = ({ sources: sourcesList }: newSources) => {
      for (const source of sourcesList) {
        sources.push(source);
      }
    };

    this.protocolClient.Debugger.addNewSourceListener(newSourceListener);
    this.protocolClient.Debugger.addNewSourcesListener(newSourcesListener);
    await this.protocolClient.Debugger.findSources({}, sessionId);
    this.protocolClient.Debugger.removeNewSourceListener(newSourceListener);
    this.protocolClient.Debugger.removeNewSourcesListener(newSourcesListener);

    // this._threadFront.markSourcesLoaded();

    return sources;
  }

  async getAllFrames(pauseId: PauseId): Promise<getAllFramesResult> {
    const sessionId = this.getSessionIdThrows();
    const result = await this.protocolClient.Pause.getAllFrames({}, sessionId, pauseId);
    return result;
  }

  async getTopFrame(pauseId: PauseId): Promise<getTopFrameResult> {
    const sessionId = this.getSessionIdThrows();
    const result = await this.protocolClient.Pause.getTopFrame({}, sessionId, pauseId);
    return result;
  }

  async getAnnotationKinds(): Promise<string[]> {
    const sessionId = this.getSessionIdThrows();
    const { kinds } = await this.protocolClient.Session.getAnnotationKinds({}, sessionId);
    return kinds;
  }

  async hasAnnotationKind(kind: string): Promise<boolean> {
    const sessionId = this.getSessionIdThrows();
    const { hasKind } = await this.protocolClient.Session.hasAnnotationKind(
      { kind },
      sessionId
    );
    return hasKind;
  }

  async getEventCountForTypes(
    eventTypes: string[],
    range: PointRange | null
  ): Promise<Record<string, number>> {
    const sessionId = this.getSessionIdThrows();
    const { counts } = await this.protocolClient.Debugger.getEventHandlerCounts(
      { eventTypes, range: range ?? undefined },
      sessionId
    );
    return Object.fromEntries(counts.map(({ type, count }) => [type, count]));
  }

  async getAllEventHandlerCounts(
    range: PointRange | null
  ): Promise<Record<string, number>> {
    const sessionId = this.getSessionIdThrows();
    const { counts } = await this.protocolClient.Debugger.getAllEventHandlerCounts(
      { range: range ?? undefined },
      sessionId
    );
    const countsObject = Object.fromEntries(
      counts.map(({ type, count }) => [type, count])
    );
    return countsObject;
  }

  getExceptionValue(pauseId: PauseId): Promise<getExceptionValueResult> {
    const sessionId = this.getSessionIdThrows();
    return this.protocolClient.Pause.getExceptionValue({}, sessionId, pauseId);
  }

  async getFocusWindow(): Promise<TimeStampedPointRange> {
    const sessionId = this.getSessionIdThrows();
    const { window } = await this.protocolClient.Session.getFocusWindow({}, sessionId);
    return window;
  }

  async getFrameSteps(pauseId: PauseId, frameId: FrameId): Promise<PointDescription[]> {
    const sessionId = this.getSessionIdThrows();
    const { steps } = await this.protocolClient.Pause.getFrameSteps(
      { frameId },
      sessionId,
      pauseId
    );
    return steps;
  }

  async getObjectProperty(
    objectId: ObjectId,
    pauseId: PauseId,
    propertyName: string
  ): Promise<Result> {
    const sessionId = this.getSessionIdThrows();
    const { result } = await this.protocolClient.Pause.getObjectProperty(
      {
        object: objectId,
        name: propertyName,
      },
      sessionId,
      pauseId
    );
    return result;
  }

  async getObjectWithPreview(
    objectId: ObjectId,
    pauseId: PauseId,
    level?: ObjectPreviewLevel
  ): Promise<PauseData> {
    const sessionId = this.getSessionIdThrows();
    const result = await this.protocolClient.Pause.getObjectPreview(
      { level, object: objectId },
      sessionId,
      pauseId || undefined
    );
    return result.data;
  }

  async getPointNearTime(time: number): Promise<TimeStampedPoint> {
    const sessionId = this.getSessionIdThrows();

    const { point } = await this.protocolClient.Session.getPointNearTime(
      { time },
      sessionId
    );
    return point;
  }

  async getPointsBoundingTime(time: number): Promise<PointsBoundingTime> {
    const sessionId = this.getSessionIdThrows();

    const result = await this.protocolClient.Session.getPointsBoundingTime(
      { time },
      sessionId
    );
    return result;
  }

  getCorrespondingLocations(location: Location): Location[] {
    const { column, line, sourceId } = location;
    const sourceIds = this.getCorrespondingSourceIds(sourceId);
    return sourceIds.map(sourceId => ({
      column,
      line,
      sourceId,
    }));
  }

  getCorrespondingSourceIds(sourceId: SourceId): SourceId[] {
    if (this._sourcesById) {
      return getCorrespondingSourceIds(this._sourcesById, sourceId);
    }
    return [sourceId];
  }

  getPreferredLocation(locations: Location[]): Location | null {
    if (this._injectedGetPreferredLocation != null) {
      return this._injectedGetPreferredLocation(locations);
    }

    return locations[0] || null;
  }

  getRecordingId(): RecordingId | null {
    return this._recordingId;
  }

  async getScope(pauseId: PauseId, scopeId: ScopeId): Promise<getScopeResult> {
    const sessionId = this.getSessionIdThrows();
    const result = await this.protocolClient.Pause.getScope(
      { scope: scopeId },
      sessionId,
      pauseId
    );
    return result;
  }

  async getScopeMap(location: Location): Promise<VariableMapping[] | undefined> {
    const sessionId = this.getSessionIdThrows();
    const { map } = await this.protocolClient.Debugger.getScopeMap(
      { location },
      sessionId
    );
    return map;
  }

  async mapExpressionToGeneratedScope(
    expression: string,
    location: Location
  ): Promise<string> {
    const sessionId = this.getSessionIdThrows();
    const result = await this.protocolClient.Debugger.mapExpressionToGeneratedScope(
      { expression, location },
      sessionId
    );
    return result.expression;
  }

  async getSessionEndpoint(sessionId: SessionId): Promise<TimeStampedPoint> {
    const { endpoint } = await this.protocolClient.Session.getEndpoint({}, sessionId);
    return endpoint;
  }

  getSessionId(): SessionId | undefined {
    return this._sessionId;
  }

  async getSourceHitCounts(
    sourceId: SourceId,
    locationRange: SourceLocationRange,
    sortedSourceLocations: SameLineSourceLocations[],
    focusRange: PointRange | null
  ): Promise<LineNumberToHitCountMap> {
    const sessionId = this.getSessionIdThrows();

    // Don't try to fetch hit counts in unloaded regions.
    // The result might be invalid (and may get cached by a Suspense caller).
    await this._waitForRangeToBeLoaded(focusRange);

    // The protocol returns possible breakpoints for the entire source,
    // but for large sources this can result in "too many locations" to run hit counts.
    // To avoid this, we limit the number of lines we request hit count information for.
    //
    // Note that since this is a sorted array, we can do better than a plain .filter() for performance.
    const startLine = locationRange.start.line;
    const startIndex = binarySearch(
      0,
      sortedSourceLocations.length,
      (index: number) => startLine - sortedSourceLocations[index].line
    );
    const endLine = locationRange.end.line;
    const stopIndex = binarySearch(
      startIndex,
      sortedSourceLocations.length,
      (index: number) => endLine - sortedSourceLocations[index].line
    );

    const firstColumnLocations = sortedSourceLocations
      .slice(startIndex, stopIndex + 1)
      .map(location => ({
        ...location,
        columns: location.columns.slice(0, 1),
      }));
    const correspondingSourceIds = this.getCorrespondingSourceIds(sourceId);

    const hitCounts: LineNumberToHitCountMap = new Map();

    await Promise.all(
      correspondingSourceIds.map(async sourceId => {
        const {
          hits: protocolHitCounts,
        } = await this.protocolClient.Debugger.getHitCounts(
          {
            sourceId,
            locations: firstColumnLocations,
            maxHits: MAX_POINTS_TO_FIND,
            range: focusRange || undefined,
          },
          sessionId
        );

        const lines: Set<number> = new Set();

        // Sum hits across corresponding sources,
        // But only record the first column's hits for any given line in a source.
        protocolHitCounts.forEach(({ hits, location }) => {
          const { line } = location;
          if (!lines.has(line)) {
            lines.add(line);

            const previous = hitCounts.get(line) || 0;
            if (previous) {
              hitCounts.set(line, {
                count: previous.count + hits,
                firstBreakableColumnIndex: previous.firstBreakableColumnIndex,
              });
            } else {
              hitCounts.set(line, {
                count: hits,
                firstBreakableColumnIndex: location.column,
              });
            }
          }
        });

        return hitCounts;
      })
    );

    return hitCounts;
  }

  getSourceOutline(sourceId: SourceId) {
    return this.protocolClient.Debugger.getSourceOutline(
      { sourceId },
      this.getSessionIdThrows()
    );
  }

  async getBreakpointPositions(
    sourceId: SourceId,
    locationRange: SourceLocationRange | null
  ): Promise<SameLineSourceLocations[]> {
    const sessionId = this.getSessionIdThrows();
    const begin = locationRange ? locationRange.start : undefined;
    const end = locationRange ? locationRange.end : undefined;

    const { lineLocations } = await this.protocolClient.Debugger.getPossibleBreakpoints(
      { sourceId: sourceId, begin, end },
      sessionId
    );

    // Ensure breakpoint positions are sorted by line ascending
    lineLocations!.sort((a, b) => a.line - b.line);

    return lineLocations!;
  }

  async getMappedLocation(location: Location): Promise<MappedLocation> {
    const sessionId = this.getSessionIdThrows();
    const { mappedLocation } = await this.protocolClient.Debugger.getMappedLocation(
      { location },
      sessionId
    );
    return mappedLocation;
  }

  async requestFocusRange(range: FocusWindowRequest): Promise<TimeStampedPointRange> {
    const sessionId = this.getSessionIdThrows();
    const { window } = await this.protocolClient.Session.requestFocusRange(
      { range },
      sessionId
    );

    return window;
  }

  // isOriginalSource(sourceId: SourceId): boolean {
  //   return this._threadFront.isOriginalSource(sourceId);
  // }

  // isPrettyPrintedSource(sourceId: SourceId): boolean {
  //   return this._threadFront.isPrettyPrintedSource(sourceId);
  // }

  removeEventListener(type: ReplayClientEvents, handler: EventListenerCallback): void {
    if (this._eventHandlers.has(type)) {
      const handlers = this._eventHandlers.get(type)!;
      const index = handlers.indexOf(handler);
      if (index >= 0) {
        handlers.splice(index, 1);
      }
    }
  }

  repaintGraphics(pauseId: PauseId): Promise<repaintGraphicsResult> {
    const sessionId = this.getSessionIdThrows();
    return this.protocolClient.DOM.repaintGraphics({}, sessionId, pauseId);
  }

  /**
   * Matches can be streamed in over time, so we need to support a callback that can receive them incrementally
   */
  async searchFunctions(
    {
      query,
      sourceIds,
    }: {
      query: string;
      sourceIds?: string[];
    },
    onMatches: (matches: FunctionMatch[]) => void
  ): Promise<void> {
    const sessionId = this.getSessionIdThrows();
    const thisSearchUniqueId = uniqueId("search-fns-");

    let pendingMatches: FunctionMatch[] = [];

    // It's important to buffer the chunks before passing them along to subscribers.
    // The backend decides how big each streaming chunk should be,
    // but if chunks are too small (and events are too close together)
    // then we may schedule too many updates with React and causing a lot of memory pressure.
    const onMatchesThrottled = throttle(() => {
      onMatches(pendingMatches);
      pendingMatches = [];
    }, STREAMING_THROTTLE_DURATION);

    const matchesListener = ({ searchId, matches }: functionsMatches) => {
      if (searchId === thisSearchUniqueId) {
        pendingMatches = pendingMatches.concat(matches);
        onMatchesThrottled();
      }
    };

    this.protocolClient.Debugger.addFunctionsMatchesListener(matchesListener);
    try {
      await this.protocolClient.Debugger.searchFunctions(
        { searchId: thisSearchUniqueId, sourceIds, query },
        sessionId
      );
    } finally {
      this.protocolClient.Debugger.removeFunctionsMatchesListener(matchesListener);
    }

    // Because the matches callback is throttled, we may still have a bit of
    // leftover data that hasn't been handled yet, even though the server API
    // promise has resolved. Delay-loop until that's done, so that the logic
    // that called this method knows when it's safe to continue.
    while (pendingMatches.length > 0) {
      await waitForTime(10);
    }
  }

  /**
   * Matches can be streamed in over time, so we need to support a callback that can receive them incrementally
   */
  async searchSources(
    {
      limit,
      query,
      sourceIds,
    }: {
      limit?: number;
      query: string;
      sourceIds?: string[];
    },
    onMatches: (matches: SearchSourceContentsMatch[], didOverflow: boolean) => void
  ): Promise<void> {
    const sessionId = this.getSessionIdThrows();
    const thisSearchUniqueId = uniqueId("search-sources-");

    let didOverflow = false;
    let pendingMatches: SearchSourceContentsMatch[] = [];
    let pendingThrottlePromise: Promise<void> | null = null;
    let resolvePendingThrottlePromise: (() => void) | null = null;

    // It's important to buffer the chunks before passing them along to subscribers.
    // The backend decides how big each streaming chunk should be,
    // but if chunks are too small (and events are too close together)
    // then we may schedule too many updates with React and causing a lot of memory pressure.
    const onMatchesThrottled = throttle(() => {
      onMatches(pendingMatches, didOverflow);
      pendingMatches = [];

      if (resolvePendingThrottlePromise !== null) {
        resolvePendingThrottlePromise();
        pendingThrottlePromise = null;
      }
    }, STREAMING_THROTTLE_DURATION);

    const matchesListener = ({
      matches,
      overflow,
      searchId,
    }: searchSourceContentsMatches) => {
      if (searchId === thisSearchUniqueId) {
        didOverflow ||= overflow;
        pendingMatches = pendingMatches.concat(matches);

        if (pendingThrottlePromise === null) {
          pendingThrottlePromise = new Promise(resolve => {
            resolvePendingThrottlePromise = resolve;
          });
        }

        onMatchesThrottled();
      }
    };

    this.protocolClient.Debugger.addSearchSourceContentsMatchesListener(matchesListener);
    try {
      await this.protocolClient.Debugger.searchSourceContents(
        { limit, searchId: thisSearchUniqueId, sourceIds, query },
        sessionId
      );

      // Don't resolve the outer Promise until the last chunk has been processed.
      if (pendingThrottlePromise !== null) {
        await pendingThrottlePromise;
      }
    } finally {
      this.protocolClient.Debugger.removeSearchSourceContentsMatchesListener(
        matchesListener
      );
    }
  }

  async runEvaluation(
    opts: {
      selector: PointSelector;
      expression: string;
      frameIndex?: number;
      fullPropertyPreview?: boolean;
      limits?: PointPageLimits;
    },
    onResults: (results: RunEvaluationResult[]) => void
  ): Promise<void> {
    const sessionId = this.getSessionIdThrows();
    const runEvaluationId = String(this.nextRunEvaluationId++);
    const pointLimits: PointPageLimits = opts.limits ? { ...opts.limits } : {};
    if (!pointLimits.maxCount) {
      pointLimits.maxCount = MAX_POINTS_TO_RUN_EVALUATION;
    }

    await this._waitForRangeToBeLoaded(
      pointLimits.begin && pointLimits.end
        ? { begin: pointLimits.begin, end: pointLimits.end }
        : null
    );

    function onResultsWrapper(results: runEvaluationResults) {
      if (results.runEvaluationId === runEvaluationId) {
        onResults(results.results);
      }
    }

    this.protocolClient.Session.addRunEvaluationResultsListener(onResultsWrapper);

    let result;
    try {
      result = await this.protocolClient.Session.runEvaluation(
        {
          expression: opts.expression,
          frameIndex: opts.frameIndex,
          fullReturnedPropertyPreview: opts.fullPropertyPreview,
          pointLimits,
          pointSelector: opts.selector,
          runEvaluationId,
        },
        sessionId
      );
    } finally {
      this.protocolClient.Session.removeRunEvaluationResultsListener(onResultsWrapper);
    }

    if (result.nextBegin) {
      throw commandError("Too many points", ProtocolError.TooManyPoints);
    }
  }

  async streamSourceContents(
    sourceId: SourceId,
    onSourceContentsInfo: (params: sourceContentsInfo) => void,
    onSourceContentsChunk: (params: sourceContentsChunk) => void
  ): Promise<void> {
    const sessionId = this.getSessionIdThrows();

    let pendingChunk = "";
    let pendingThrottlePromise: Promise<void> | null = null;
    let resolvePendingThrottlePromise: (() => void) | null = null;

    const callSourceContentsChunkThrottled = throttle(() => {
      onSourceContentsChunk({ chunk: pendingChunk, sourceId });
      pendingChunk = "";

      if (resolvePendingThrottlePromise !== null) {
        resolvePendingThrottlePromise();
        pendingThrottlePromise = null;
      }
    }, STREAMING_THROTTLE_DURATION);

    const onSourceContentsChunkWrapper = (params: sourceContentsChunk) => {
      // It's important to buffer the chunks before passing them along to subscribers.
      // The backend decides how much text to send in each chunk,
      // but if chunks are too small (and events are too close together)
      // then we may schedule too many updates with React and causing a lot of memory pressure.
      if (params.sourceId === sourceId) {
        pendingChunk += params.chunk;

        if (pendingThrottlePromise === null) {
          pendingThrottlePromise = new Promise(resolve => {
            resolvePendingThrottlePromise = resolve;
          });
        }

        callSourceContentsChunkThrottled();
      }
    };

    const onSourceContentsInfoWrapper = (params: sourceContentsInfo) => {
      if (params.sourceId === sourceId) {
        onSourceContentsInfo(params);
      }
    };

    try {
      this.protocolClient.Debugger.addSourceContentsChunkListener(
        onSourceContentsChunkWrapper
      );
      this.protocolClient.Debugger.addSourceContentsInfoListener(
        onSourceContentsInfoWrapper
      );

      await this.protocolClient.Debugger.streamSourceContents({ sourceId }, sessionId);

      // Don't resolve the outer Promise until the last chunk has been processed.
      if (pendingThrottlePromise !== null) {
        await pendingThrottlePromise;
      }
    } finally {
      this.protocolClient.Debugger.removeSourceContentsChunkListener(
        onSourceContentsChunkWrapper
      );
      this.protocolClient.Debugger.removeSourceContentsInfoListener(
        onSourceContentsInfoWrapper
      );
    }
  }

  async _waitForPointToBeLoaded(_point: ExecutionPoint): Promise<void> {
    // in routines, the entire recording is loaded, up to 3 minutes long
    return;
    // return new Promise(resolve => {
    //   const checkLoaded = () => {
    //     const loadedRegions = this.loadedRegions();
    //     let isLoaded = false;
    //     if (loadedRegions !== null) {
    //       isLoaded = isPointInRegions(point, loadedRegions.loaded);
    //     }

    //     if (isLoaded) {
    //       resolve();

    //       this.removeEventListener("loadedRegionsChange", checkLoaded);
    //     }
    //   };

    //   this.addEventListener("loadedRegionsChange", checkLoaded);

    //   checkLoaded();
    // });
  }

  async _waitForRangeToBeLoaded(
    _focusRange: TimeStampedPointRange | PointRange | null
  ): Promise<void> {
    // in routines, the entire recording is loaded, up to 3 minutes long
    return;
    // return new Promise(resolve => {
    //   const checkLoaded = () => {
    //     console.log("Loaded regions check");
    //     const loadedRegions = this.loadedRegions();
    //     console.log("Loaded regions: ", loadedRegions);
    //     let isLoaded = false;
    //     if (loadedRegions !== null && loadedRegions.loading.length > 0) {
    //       if (focusRange !== null) {
    //         isLoaded = isRangeInRegions(focusRange, loadedRegions.indexed);
    //       } else {
    //         isLoaded = areRangesEqual(loadedRegions.indexed, loadedRegions.loading);
    //       }
    //     }

    //     if (isLoaded) {
    //       resolve();

    //       this.removeEventListener("loadedRegionsChange", checkLoaded);
    //     }
    //   };

    //   this.addEventListener("loadedRegionsChange", checkLoaded);

    //   checkLoaded();
    // });
  }

  async waitForTimeToBeLoaded(time: number): Promise<void> {
    return new Promise(resolve => {
      const checkLoaded = () => {
        const loadedRegions = this.loadedRegions();
        let isLoaded = false;
        if (loadedRegions !== null) {
          isLoaded = isTimeInRegions(time, loadedRegions.loaded);
        }

        if (isLoaded) {
          resolve();

          this.removeEventListener("loadedRegionsChange", checkLoaded);
        }
      };

      this.addEventListener("loadedRegionsChange", checkLoaded);

      checkLoaded();
    });
  }

  // async waitForLoadedSources(): Promise<void> {
  //   await this._threadFront.ensureAllSources();
  // }

  _dispatchEvent(type: ReplayClientEvents, ...args: any[]): void {
    const handlers = this._eventHandlers.get(type);
    if (handlers) {
      // we iterate over a copy of the handlers array because the array
      // may be modified during the iteration by one of the handlers
      [...handlers].forEach(handler => handler(...args));
    }
  }

  _onLoadChanges = (loadedRegions: LoadedRegions) => {
    this._loadedRegions = loadedRegions;

    this._dispatchEvent("loadedRegionsChange", loadedRegions);
  };
}
