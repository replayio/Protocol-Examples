/* Copyright 2023 Record Replay Inc. */

import {
  CallStack,
  ExecutionPoint,
  Frame,
  FrameId,
  MappedLocation,
  Object as ProtocolObject,
  ObjectId,
  ObjectPreviewLevel,
  PauseData,
  PauseId,
  Result,
  Scope,
  ScopeId,
  Source as ProtocolSource,
  SourceId as ProtocolSourceId,
  SameLineSourceLocations,
  SourceId,
  getSourceOutlineResult,
  SourceLocationRange,
  ContentType,
} from "@replayio/protocol";
import cloneDeep from "lodash/cloneDeep";
import {
  Cache,
  StreamingCache,
  createCache,
  createSingleEntryCache,
  createStreamingCache,
} from "suspense";

import { ReplayClientInterface } from "../replayClient";
import { SourceDetails, SourcesById, isLocationBefore, processSources } from "../sources";
import { assert } from "../utils";

interface Features {
  chromiumRepaints: boolean;
  repaintEvaluations: boolean;
}

export const features: Features = {
  chromiumRepaints: false,
  repaintEvaluations: false,
};

// Target applications which can create recordings.
export enum RecordingTarget {
  gecko = "gecko",
  chromium = "chromium",
  node = "node",
  unknown = "unknown",
}

export type RecordingCapabilities = {
  supportsEagerEvaluation: boolean;
  supportsElementsInspector: boolean;
  supportsEventTypes: boolean;
  supportsNetworkRequests: boolean;
  supportsRepaintingGraphics: boolean;
  supportsPureEvaluation: boolean;
};

export interface FrameScopes {
  frameLocation: MappedLocation;
  generatedScopes: Scope[];
  originalScopes: Scope[] | undefined;
}

export type BreakpointPositionsResult = [
  breakablePositions: SameLineSourceLocations[],
  breakablePositionsByLine: Map<number, SameLineSourceLocations>
];

export type ObjectCache = Cache<
  [
    client: ReplayClientInterface,
    pauseId: PauseId,
    objectId: ObjectId,
    previewLevel: ObjectPreviewLevel
  ],
  ProtocolObject
>;

type PauseIdCache = Cache<
  [replayClient: ReplayClientInterface, executionPoint: ExecutionPoint, time: number],
  PauseId
>;

type PauseEvaluationsCache = Cache<
  [
    replayClient: ReplayClientInterface,
    pauseId: PauseId,
    frameId: FrameId | null,
    expression: string,
    uid?: string
  ],
  Omit<Result, "data">
>;

export type FramesCache = Cache<
  [replayClient: ReplayClientInterface, pauseId: PauseId],
  Frame[] | undefined
>;

export type TopFrameCache = Cache<
  [replayClient: ReplayClientInterface, pauseId: PauseId],
  Frame | undefined
>;

export type ScopesCache = Cache<
  [replayClient: ReplayClientInterface, pauseId: PauseId, scopeId: ScopeId],
  Scope
>;

export type SourcesCache = Cache<[client: ReplayClientInterface], ProtocolSource[]>;

export type SourcesByIdCache = Cache<[client: ReplayClientInterface], SourcesById>;

export type SourceOutlineCache = Cache<
  [replayClient: ReplayClientInterface, sourceId: SourceId | undefined],
  getSourceOutlineResult
>;

type StreamingSourceContentsParams = [
  client: ReplayClientInterface,
  sourceId: ProtocolSourceId
];
type StreamingSourceContentsData = {
  codeUnitCount: number;
  contentType: ContentType;
  lineCount: number;
};

export type StreamingSourceContentsCache = StreamingCache<
  StreamingSourceContentsParams,
  string,
  StreamingSourceContentsData
>;

export type BreakpointPositionsCache = Cache<
  [replayClient: ReplayClientInterface, sourceId: ProtocolSourceId],
  BreakpointPositionsResult
>;

export type BuildIdCache = Cache<[client: ReplayClientInterface], string>;

export type RecordingTargetCache = Cache<
  [client: ReplayClientInterface],
  RecordingTarget
>;

export type RecordingCapabilitiesCache = Cache<
  [replayClient: ReplayClientInterface],
  RecordingCapabilities
>;

export interface CachesCollection {
  objectCache: ObjectCache;
  pauseIdCache: PauseIdCache;
  pauseEvaluationsCache: PauseEvaluationsCache;
  framesCache: FramesCache;
  topFrameCache: TopFrameCache;
  scopesCache: ScopesCache;
  sourcesCache: SourcesCache;
  sourcesByIdCache: SourcesByIdCache;
  sourceOutlineCache: SourceOutlineCache;
  sourceContentsCache: StreamingSourceContentsCache;
  breakpointPositionsCache: BreakpointPositionsCache;
  buildIdCache: BuildIdCache;
  recordingTargetCache: RecordingTargetCache;
  recordingCapabilitiesCache: RecordingCapabilitiesCache;
  cachePauseData(
    replayClient: ReplayClientInterface,
    pauseId: PauseId,
    pauseData: PauseData,
    stack?: CallStack
  ): void;
  getCachedObject(pauseId: PauseId, objectId: ObjectId): ProtocolObject | null;
  preCacheObjects(pauseId: PauseId, objects: ProtocolObject[]): void;
  preCacheObject(pauseId: PauseId, object: ProtocolObject): void;
  updateMappedLocation(
    client: ReplayClientInterface,
    mappedLocation: MappedLocation
  ): void;
}

function getRecordingTarget(buildId: string): RecordingTarget {
  if (buildId.includes("gecko")) {
    return RecordingTarget.gecko;
  }
  if (buildId.includes("chromium")) {
    return RecordingTarget.chromium;
  }
  if (buildId.includes("node")) {
    return RecordingTarget.node;
  }
  return RecordingTarget.unknown;
}

function getRecordingCapabilities(buildId: string) {
  const recordingTarget = getRecordingTarget(buildId);
  switch (recordingTarget) {
    case "chromium": {
      return {
        supportsEagerEvaluation: false,
        supportsElementsInspector: true,
        supportsEventTypes: true,
        supportsNetworkRequests: false,
        supportsRepaintingGraphics: features.chromiumRepaints,
        supportsPureEvaluation: false,
      };
    }
    case "gecko": {
      return {
        supportsEagerEvaluation: true,
        supportsElementsInspector: true,
        supportsEventTypes: true,
        supportsNetworkRequests: true,
        supportsRepaintingGraphics: true,
        supportsPureEvaluation: true,
      };
    }
    case "node": {
      return {
        supportsEagerEvaluation: true,
        supportsElementsInspector: false,
        supportsEventTypes: false,
        supportsNetworkRequests: true,
        supportsRepaintingGraphics: false,
        supportsPureEvaluation: false,
      };
    }
    case "unknown":
    default: {
      return {
        supportsEagerEvaluation: false,
        supportsElementsInspector: false,
        supportsEventTypes: false,
        supportsNetworkRequests: false,
        supportsRepaintingGraphics: false,
        supportsPureEvaluation: false,
      };
    }
  }
}

export function createCaches(): CachesCollection {
  const objectCache: ObjectCache = createCache({
    debugLabel: "objectCache",
    getKey: ([_client, pauseId, objectId, previewLevel]) =>
      `${pauseId}:${objectId}:${previewLevel}`,
    load: async ([client, pauseId, objectId, previewLevel]) => {
      const data = await client.getObjectWithPreview(objectId, pauseId, previewLevel);

      cachePauseData(client, pauseId, data);

      // cachePauseData() calls preCacheObjects()
      // so the object should be in the cache now
      return objectCache.getValue(client, pauseId, objectId, previewLevel);
    },
  });

  // This method is safe to call outside of render.
  // The Objects it returns are not guaranteed to contain preview information.
  function getCachedObject(pauseId: PauseId, objectId: ObjectId): ProtocolObject | null {
    // The objectCache only uses the "client" param for fetching values, not caching them
    const nullClient = null as any;
    return (
      objectCache.getValueIfCached(nullClient, pauseId, objectId, "full") ??
      objectCache.getValueIfCached(nullClient, pauseId, objectId, "canOverflow") ??
      objectCache.getValueIfCached(nullClient, pauseId, objectId, "none") ??
      null
    );
  }

  function preCacheObjects(pauseId: PauseId, objects: ProtocolObject[]): void {
    objects.forEach(object => preCacheObject(pauseId, object));
  }

  function preCacheObject(pauseId: PauseId, object: ProtocolObject): void {
    const { objectId } = object;

    // Always cache basic object data
    objectCache.cache(object, null as any, pauseId, objectId, "none");

    // Only cache objects with previews if they meet the criteria
    if (object.preview != null) {
      objectCache.cache(object, null as any, pauseId, objectId, "canOverflow");

      if (!object.preview.overflow) {
        objectCache.cache(object, null as any, pauseId, objectId, "full");
      }
    }
  }

  const pauseIdToPointAndTimeMap: Map<PauseId, [ExecutionPoint, number]> = new Map();

  const pauseIdCache: PauseIdCache = createCache({
    debugLabel: "PauseIdForExecutionPoint",
    getKey: ([_replayClient, executionPoint, time]) => `${executionPoint}:${time}`,
    load: async ([replayClient, executionPoint, time]) => {
      const { pauseId } = await replayClient.createPause(executionPoint);

      pauseIdToPointAndTimeMap.set(pauseId, [executionPoint, time]);

      await sourcesCache.readAsync(replayClient);

      return pauseId;
    },
  });

  const pauseEvaluationsCache: PauseEvaluationsCache = createCache({
    debugLabel: "PauseEvaluations",
    getKey: ([_replayClient, pauseId, frameId, expression, uid = ""]) =>
      `${pauseId}:${frameId}:${expression}:${uid}`,
    load: async ([replayClient, pauseId, frameId, expression, _uid = ""]) => {
      const result = await replayClient.evaluateExpression(pauseId, expression, frameId);
      await sourcesCache.readAsync(replayClient);
      cachePauseData(replayClient, pauseId, result.data);
      return {
        exception: result.exception,
        failed: result.failed,
        returned: result.returned,
      };
    },
  });

  function cachePauseData(
    replayClient: ReplayClientInterface,
    pauseId: PauseId,
    pauseData: PauseData,
    stack?: CallStack
  ) {
    if (pauseData.objects) {
      pauseData.objects.forEach(object => {
        const { objectId } = object;

        // Always cache basic object data
        objectCache.cache(object, null as any, pauseId, objectId, "none");

        // Only cache objects with previews if they meet the criteria
        if (object.preview != null) {
          objectCache.cache(object, null as any, pauseId, objectId, "canOverflow");

          if (!object.preview.overflow) {
            objectCache.cache(object, null as any, pauseId, objectId, "full");
          }
        }
      });
    }
    if (stack) {
      const frames = sortFramesAndUpdateLocations(
        replayClient,
        pauseData.frames || [],
        stack
      );
      if (frames) {
        framesCache.cache(frames, replayClient, pauseId);
      }
    }
    if (pauseData.scopes) {
      for (const scope of pauseData.scopes) {
        scopesCache.cache(scope, replayClient, pauseId, scope.scopeId);
      }
    }
  }

  const framesCache: FramesCache = createCache({
    debugLabel: "FramesCache",
    getKey: ([_client, pauseId]) => pauseId,
    load: async ([client, pauseId]) => {
      const framesResult = await client.getAllFrames(pauseId);
      await sourcesCache.readAsync(client);
      cachePauseData(client, pauseId, framesResult.data, framesResult.frames);
      const cached = framesCache.getValueIfCached(client, pauseId);
      assert(cached, `Frames for pause ${pauseId} not found in cache`);
      return cached;
    },
  });

  const topFrameCache: TopFrameCache = createCache({
    debugLabel: "TopFrame",
    getKey: ([_client, pauseId]) => pauseId,
    load: async ([client, pauseId]) => {
      // In most cases, we probably already have a full set of frames cached for this pause ID.
      // Try to use the first frame from there if possible.
      const existingCachedFrames = framesCache.getValueIfCached(client, pauseId);
      if (existingCachedFrames) {
        return existingCachedFrames[0];
      }

      // Otherwise, we'll use a lighter-weight `Pause.getTopFrame` request. The object
      // that comes back _should_ be the same either way.
      const framesResult = await client.getTopFrame(pauseId);
      const { frame: frameId } = framesResult;

      if (frameId === undefined) {
        return;
      }
      await sourcesCache.readAsync(client);
      // We _don't_ want to pass in a `stack` arg here. That will result in this frame
      // being added to the "all frames cache" as the cached value for this pause ID.
      // If someone asks for _all_ frames for the pause later, that would prevent the
      // full list of frames from being fetched.
      cachePauseData(client, pauseId, framesResult.data);
      const updatedFrames = sortFramesAndUpdateLocations(
        client,
        framesResult.data?.frames ?? [],
        [frameId]
      );

      // Instead, we'll update the locations in this frame ourselves.
      const topFrame = updatedFrames?.find(frame => frame.frameId === frameId);

      assert(topFrame, `Top frame for pause ${pauseId} not found in cache`);
      return topFrame;
    },
  });

  function sortFramesAndUpdateLocations(
    client: ReplayClientInterface,
    rawFrames: Frame[],
    stack: FrameId[]
  ) {
    const frames = stack.map(frameId =>
      rawFrames?.find(frame => frame.frameId === frameId)
    );
    if (frames.every(frame => !!frame)) {
      const updatedFrames = frames.map(frame => cloneDeep(frame!));
      for (const frame of updatedFrames) {
        updateMappedLocation(client, frame.location);
        if (frame!.functionLocation) {
          updateMappedLocation(client, frame.functionLocation);
        }
      }
      return updatedFrames;
    }
  }

  function updateMappedLocation(
    client: ReplayClientInterface,
    mappedLocation: MappedLocation
  ) {
    for (const location of mappedLocation) {
      location.sourceId = client.getCorrespondingSourceIds(location.sourceId)[0];
    }
  }

  const scopesCache: ScopesCache = createCache({
    debugLabel: "Scopes",
    getKey: ([_replayClient, pauseId, scopeId]) => `${pauseId}:${scopeId}`,
    load: async ([replayClient, pauseId, scopeId]) => {
      const result = await replayClient.getScope(pauseId, scopeId);
      await sourcesCache.readAsync(replayClient);

      cachePauseData(replayClient, pauseId, result.data);

      // Caching PauseData should also cache values in this cache
      const cached = scopesCache.getValueIfCached(replayClient, pauseId, scopeId);
      assert(cached, `Scope ${scopeId} for pause ${pauseId} not found in cache`);

      return cached;
    },
  });

  const sourcesCache: Cache<
    [client: ReplayClientInterface],
    SourceDetails[]
  > = createSingleEntryCache({
    debugLabel: "Sources",
    load: async ([client]) => {
      const protocolSources = await client.findSources();
      return processSources(protocolSources);
    },
  });

  const sourcesByIdCache: SourcesByIdCache = createSingleEntryCache({
    debugLabel: "SourcesById",
    load: async ([client]) => {
      const allSources = await sourcesCache.readAsync(client);
      const sourcesById: SourcesById = {};
      for (const source of allSources) {
        sourcesById[source.sourceId] = source;
      }

      return sourcesById;
    },
  });

  const sourceOutlineCache: SourceOutlineCache = createCache({
    config: { immutable: true },
    debugLabel: "sourceOutlineCache",
    getKey: ([_replayClient, sourceId]) => sourceId ?? "",
    load: async ([replayClient, sourceId]) => {
      try {
        const result = sourceId
          ? await replayClient.getSourceOutline(sourceId)
          : { functions: [], classes: [] };

        interface OutlineItem {
          location: SourceLocationRange;
        }
        const sortOutlineItems = (a: OutlineItem, b: OutlineItem) => {
          return isLocationBefore(a.location.begin, b.location.begin) ? -1 : 1;
        };

        result.functions.sort(sortOutlineItems);

        result.classes.sort(sortOutlineItems);

        return result;
      } catch (err) {
        console.error("Error reading source outline", err);
        throw err;
      }
    },
  });

  const breakpointPositionsCache: BreakpointPositionsCache = createCache({
    config: { immutable: true },
    debugLabel: "BreakpointPositions",
    getKey: ([_client, sourceId]) => sourceId,
    load: async ([client, sourceId]) => {
      const breakablePositions = await client.getBreakpointPositions(sourceId, null);

      const breakablePositionsByLine = new Map<number, SameLineSourceLocations>();
      // The positions are already sorted by line number in `ReplayClient.getBreakpointPositions`
      for (const position of breakablePositions) {
        // TODO BAC-2329
        // The backend sometimes returns duplicate columns per line;
        // In order to prevent the frontend from showing something weird, let's dedupe them here.
        const uniqueSortedColumns = Array.from(new Set(position.columns));
        uniqueSortedColumns.sort((a, b) => a - b);
        position.columns = uniqueSortedColumns;

        // Maps iterate items in insertion order - this is useful later
        breakablePositionsByLine.set(position.line, position);
      }
      return [breakablePositions, breakablePositionsByLine];
    },
  });

  const sourceContentsCache: StreamingSourceContentsCache = createStreamingCache({
    debugLabel: "StreamingSourceContents",
    getKey: (client, sourceId) => sourceId,
    load: async ({ update, reject, resolve }, client, sourceId) => {
      try {
        let data: StreamingSourceContentsData | null = null;
        let contents = "";

        // Fire and forget; data streams in.
        await client.streamSourceContents(
          sourceId,
          ({ codeUnitCount, contentType, lineCount }) => {
            data = { codeUnitCount, contentType, lineCount };
            update("", 0, data);
          },
          ({ chunk }) => {
            contents += chunk;

            update(contents, contents.length / data!.codeUnitCount, data!);
          }
        );

        resolve();
      } catch (error) {
        reject(error);
      }
    },
  });

  const buildIdCache: BuildIdCache = createSingleEntryCache({
    config: { immutable: true },
    debugLabel: "buildIdCache",
    load: ([replayClient]) => replayClient.getBuildId(),
  });

  const recordingTargetCache: RecordingTargetCache = createSingleEntryCache({
    config: { immutable: true },
    debugLabel: "recordingTargetCache",
    load: async ([replayClient]) => {
      const buildId = await buildIdCache.readAsync(replayClient);
      return getRecordingTarget(buildId);
    },
  });

  const recordingCapabilitiesCache: RecordingCapabilitiesCache = createSingleEntryCache({
    config: { immutable: true },
    debugLabel: "recordingCapabilitiesCache",
    load: async ([replayClient]) => {
      const recordingTarget = await recordingTargetCache.readAsync(replayClient);
      return getRecordingCapabilities(recordingTarget);
    },
  });

  return {
    objectCache,
    pauseIdCache,
    pauseEvaluationsCache,
    framesCache,
    topFrameCache,
    scopesCache,
    sourcesCache,
    sourcesByIdCache,
    sourceOutlineCache,
    sourceContentsCache,
    breakpointPositionsCache,
    buildIdCache,
    recordingTargetCache,
    recordingCapabilitiesCache,
    cachePauseData,
    getCachedObject,
    preCacheObjects,
    preCacheObject,
    updateMappedLocation,
  };
}
