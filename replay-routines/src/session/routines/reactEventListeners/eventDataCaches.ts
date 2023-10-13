/* Copyright 2023 Record Replay Inc. */

// Caches for event data used by the React Event Listeners routine

import {
  EventHandlerType,
  ExecutionPoint,
  PointDescription,
  PointRange,
  PointSelector,
} from "@replayio/protocol";

import { CachesCollection } from "../shared/caches/ProtocolDataCaches";
import { Cache, createCache, createIntervalCache, IntervalCache } from "suspense";
import { ReplayClientInterface } from "../shared/replayClient";
import { countEvents, EventCategory } from "../shared/events/eventParsing";
import { compareExecutionPoints } from "../shared/time";
import { updateMappedLocation } from "../shared/sources";

type EventCountsCache = Cache<
  [client: ReplayClientInterface, range: PointRange | null],
  EventCategory[]
>;

type EventPointsCache = IntervalCache<
  ExecutionPoint,
  [client: ReplayClientInterface, eventTypes: EventHandlerType[]],
  PointDescription
>;

export type EventCachesCollection = {
  eventCountsCache: EventCountsCache;
  eventPointsCache: EventPointsCache;
};

function createPointSelector(eventTypes: EventHandlerType[]): PointSelector {
  return { kind: "event-handlers", eventTypes };
}

export const createEventCaches = (
  cachesCollection: CachesCollection
): EventCachesCollection => {
  const eventCountsCache: EventCountsCache = createCache({
    config: { immutable: true },
    debugLabel: "EventCounts",
    getKey: ([_client, range]) => (range ? `${range.begin}:${range.end}` : ""),
    load: async ([replayClient, range]) => {
      const allEvents = await replayClient.getAllEventHandlerCounts(range);
      const recordingTarget = await cachesCollection.recordingTargetCache.readAsync(
        replayClient
      );
      return countEvents(allEvents, recordingTarget);
    },
  });

  const eventPointsCache: EventPointsCache = createIntervalCache({
    debugLabel: "EventPoints",
    getKey: (client, eventTypes) => eventTypes.join(),
    getPointForValue: pointDescription => pointDescription.point,
    comparePoints: compareExecutionPoints,
    load: async (begin, end, replayClient, eventTypes) => {
      const points = await replayClient.findPoints(createPointSelector(eventTypes), {
        begin,
        end,
      });

      const sourcesById = await cachesCollection.sourcesByIdCache.readAsync(replayClient);

      points.forEach(p => {
        if (p?.frame?.length) {
          updateMappedLocation(sourcesById, p.frame);
        }
      });

      return points;
    },
  });

  return {
    eventCountsCache,
    eventPointsCache,
  };
};
