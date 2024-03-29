/* Copyright 2023 Record Replay Inc. */

import groupBy from "lodash/groupBy";
import isEmpty from "lodash/isEmpty";
import without from "lodash/without";

import { RecordingTarget } from "../caches/ProtocolDataCaches";
import { STANDARD_EVENT_CATEGORIES } from "./eventConstants";
import { EventHandlerType } from "@replayio/protocol";

export type Event = {
  count: number;
  label: string;
  type: EventHandlerType;
  /**
   * Set of event types sent from the runtime that map to this normalized event entry.
   */
  rawEventTypes: string[];
};

export type EventCategory = {
  category: string;
  events: Event[];
};

type EventCategoriesByEvent = Record<string, string>;
type EventCategoriesByEventAndTarget = Record<string, Record<string, string>>;

/**
 * Takes an array of [Key, Value | Value[]] entries, and groups them by key.
 * @return A new entry array, where values of the same key are merged into one entry.
 */
export function groupEntries<K, V>(entries: [K, V | V[]][]): [K, V[]][] {
  return Object.values(groupBy(entries, x => x[0])).map(group => [
    group[0][0],
    group.flatMap(([_k, v]) => v),
  ]);
}

/**
 * Encode a Chromium event type, based on its category and non-unique event type.
 */
export function makeChromiumEventType(nonUniqueEventType: string, category?: string) {
  if (category) {
    return `${category}.${nonUniqueEventType}`;
  }

  // we were not able to match this event type to a pre-defined category
  return nonUniqueEventType;
}

/**
 * NOTE: The `rawEventType` is produced in MakeReplayMakeEventType in chromium's
 *   `InspectorDOMDebuggerAgent`.
 * @see https://github.com/replayio/chromium/blob/509fb5f3c3a587ebef668a631a53eed83acc2f85/third_party/blink/renderer/core/inspector/inspector_dom_debugger_agent.cc#L940
 */
function decodeChromiumEventType(rawEventType: string) {
  const [nonUniqueEventType, eventTargetName] = rawEventType.split(",", 2);
  return [nonUniqueEventType, eventTargetName];
}

export async function countEvents(
  eventCountsRaw: Record<string, number>,
  recordingTarget: RecordingTarget
) {
  const targetCountEvents = CountEvents[recordingTarget];
  if (!targetCountEvents) {
    if (!isEmpty(eventCountsRaw)) {
      console.error(
        `Internal Error: recordingTarget "${recordingTarget}" has events but is missing CountEvents function`
      );
    }
    return [];
  }
  const result = targetCountEvents(eventCountsRaw);
  return result;
}

type CountEventsFunction = (eventCountsRaw: Record<string, number>) => EventCategory[];

export const CountEvents: Partial<Record<RecordingTarget, CountEventsFunction>> = {
  gecko(eventCountsRaw: Record<string, number>) {
    const eventTable = STANDARD_EVENT_CATEGORIES.gecko!;
    return eventTable.map(category => {
      return {
        ...category,
        events: category.events.map(event => ({
          ...event,
          count: eventCountsRaw[event.type],
          rawEventTypes: [event.type],
        })),
      };
    });
  },
  chromium(eventCountsRaw: Record<string, number>) {
    const eventTable = STANDARD_EVENT_CATEGORIES.chromium!;

    // Merge non-unique CDT category names.
    // NOTE: at this point, we don't care about eventTargets.
    const normalizedEventTable = groupEntries(
      eventTable.map(({ category, events }) => [category, events])
    ).map(([category, events]) => ({ category, events }));

    // convert, map and merge event types
    // const normalizedEventCounts = convertChromiumEventCounts(eventCountsRaw);
    const chromiumEventCategoriesByEventDefault = makeChromiumEventCategoriesByEventDefault();
    const chromiumEventCategoriesByEventAndTarget = makeChromiumEventCategoriesByEventAndTarget();
    const normalizedEventCounts: {
      [key: string]: {
        count: number;
        rawEventTypes: string[];
      };
    } = {};
    Object.entries(eventCountsRaw).forEach(([eventInputRaw, count]) => {
      const [eventTypeRaw, eventTargetName] = decodeChromiumEventType(eventInputRaw);
      const category = lookupChromiumEventCategory(
        eventTypeRaw,
        eventTargetName,
        chromiumEventCategoriesByEventDefault,
        chromiumEventCategoriesByEventAndTarget
      );

      const uniqueEventType = makeChromiumEventType(eventTypeRaw, category);
      let entry = normalizedEventCounts[uniqueEventType];
      if (!entry) {
        normalizedEventCounts[uniqueEventType] = entry = {
          count: 0,
          rawEventTypes: [],
        };
      }
      entry.count += count;
      entry.rawEventTypes.push(eventInputRaw);
    });

    // produce eventTable with counts
    const result = normalizedEventTable.map(category => {
      return {
        ...category,
        events: category.events.map(event => {
          const type = makeChromiumEventType(event.type, category.category);
          const countEntry = normalizedEventCounts[type];
          delete normalizedEventCounts[type];
          return {
            ...event,
            ...countEntry,
          };
        }),
      };
    });

    if (!isEmpty(normalizedEventCounts)) {
      // there are still unsorted events: add "unknown" category
      result.push({
        category: "unknown",
        events: Object.entries(normalizedEventCounts).map(([type, countEntry]) => ({
          type,
          label: `${type} (${countEntry.rawEventTypes
            .map(eventInputRaw => {
              const [, eventTargetName] = decodeChromiumEventType(eventInputRaw);
              return eventTargetName;
            })
            .join(", ")})`,
          ...countEntry,
        })),
      });
    }

    return result;
  },
};

function normalizeEventTargetName(name: string) {
  return name.toLowerCase();
}

/**
 * Find category for raw chromium event input string.
 *
 * NOTE: Chromium event names are more involved than gecko, because its event names
 * are not unique. Instead, it uses both: event name + event target name
 * to look up the "breakpoint".
 */
export function lookupChromiumEventCategory(
  eventTypeRaw: string,
  eventTargetName: string,
  chromiumEventCategoriesByEventDefault: EventCategoriesByEvent,
  chromiumEventCategoriesByEventAndTarget: EventCategoriesByEventAndTarget
) {
  // look up category
  let category = "";
  if (eventTargetName) {
    // 1. try to look up by targetName
    category =
      chromiumEventCategoriesByEventAndTarget[eventTypeRaw]?.[
        normalizeEventTargetName(eventTargetName)
      ];
  }
  if (!category) {
    // 2. try to look up default
    category = chromiumEventCategoriesByEventDefault[eventTypeRaw];
  }
  return category;
}

/**
 * This allows looking up category by non-unique event name
 * for all events that have a '*' target (or no target at all).
 *
 * @example
 * ({
 *   load: 'load',
 *   click: 'mouse',
 *   // ... 100+ more entries ...
 * })
 *
 */
export function makeChromiumEventCategoriesByEventDefault(): EventCategoriesByEvent {
  // TODO: add checks to make sure that each type only has one "default category"
  return Object.fromEntries(
    STANDARD_EVENT_CATEGORIES.chromium!.flatMap(category => {
      if (!category.eventTargets || category.eventTargets.includes("*")) {
        return category.events.map(evt => [evt.type, category.category]);
      }
      return null;
    }).filter(Boolean) as [[string, string]]
  );
}

/**
 * This allows looking up category by (1) non-unique event name -> (2) EventTarget name.
 *
 * @example
 * ({
 *   load: {
 *     xmlhttprequest: 'XHR',
 *     xmlhttprequestupload: 'XHR',
 *   },
 *   play: {
 *     video: 'Media',
 *     audio: 'Media'
 *   }
 *   // ... 100+ more entries ...
 * })
 */
export function makeChromiumEventCategoriesByEventAndTarget(): EventCategoriesByEventAndTarget {
  const nonUniqueEntries = STANDARD_EVENT_CATEGORIES.chromium!.flatMap(category => {
    const eventTargets = category.eventTargets && without(category.eventTargets, "*");
    if (!eventTargets?.length) {
      return null;
    }
    return category.events.map(
      evt =>
        [
          evt.type,
          eventTargets.map(target => [
            normalizeEventTargetName(target),
            category.category,
          ]),
        ] as [string, [string, string][]]
    );
  }).filter(Boolean) as [string, [string, string][]][];

  const uniqueEntries = groupEntries(nonUniqueEntries);
  return Object.fromEntries(
    uniqueEntries.map(([eventType, targetCategoryEntries]) => {
      return [eventType, Object.fromEntries(targetCategoryEntries)] as [
        string,
        Record<string, string>
      ];
    })
  );
}
