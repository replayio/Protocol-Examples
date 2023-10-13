/* Copyright 2023 Record Replay Inc. */

import {
  Location,
  MappedLocation,
  SourceKind as ProtocolSourceKind,
  Source as ProtocolSource,
  SourceId as ProtocolSourceId,
  SourceLocation,
} from "@replayio/protocol";

import { assert } from "./utils";

// Dictionary types from Redux Toolkit
export interface DictionaryNum<T> {
  [id: number]: T | undefined;
}

export interface Dictionary<T> extends DictionaryNum<T> {
  [id: string]: T | undefined;
}

export type EntityId = number | string;

type SourceId = string;

export interface SourceDetails {
  id: ProtocolSourceId;
  sourceId: ProtocolSourceId;
  kind: ProtocolSourceKind;
  url?: string;
  contentId: string;
  contentIdIndex: number;
  // true if there is another source with the same url but a different contentId
  doesContentIdChange: boolean;
  isSourceMapped: boolean;
  correspondingSourceIds: ProtocolSourceId[];
  generated: ProtocolSourceId[];
  generatedFrom: ProtocolSourceId[];
  prettyPrinted?: ProtocolSourceId;
  prettyPrintedFrom?: ProtocolSourceId;
}

export type SourcesById = Record<SourceId, SourceDetails>;

export class ArrayMap<K, V> {
  map: Map<K, V[]>;

  constructor() {
    this.map = new Map<K, V[]>();
  }

  add(key: K, value: V) {
    if (this.map.has(key)) {
      this.map.get(key)!.push(value);
    } else {
      this.map.set(key, [value]);
    }
  }
}

// sources with the same key will be grouped as corresponding sources
const keyForSource = (
  source: ProtocolSource,
  sources: Map<ProtocolSourceId, ProtocolSource>
) => {
  const { sourceId, kind, url, generatedSourceIds } = source;

  let contentHash = source.contentHash;
  if (kind === "prettyPrinted") {
    assert(
      generatedSourceIds?.length === 1,
      `pretty-printed source ${sourceId} should have exactly one generated source`
    );
    const minifiedSource = sources.get(generatedSourceIds[0]);
    assert(minifiedSource, `couldn't find minified source for ${sourceId}`);
    contentHash = minifiedSource.contentHash;
  }
  assert(contentHash, `couldn't determine contentHash for ${sourceId}`);

  return `${kind}:${url}:${contentHash}`;
};

export function processSources(protocolSources: ProtocolSource[]): SourceDetails[] {
  const protocolSourcesById = new Map<ProtocolSourceId, ProtocolSource>(
    protocolSources.map(source => [source.sourceId, source])
  );
  const corresponding = new ArrayMap<string, ProtocolSourceId>();
  // the ProtocolSource objects link original to generated sources, here we collect the links in the other direction
  const original = new ArrayMap<ProtocolSourceId, ProtocolSourceId>();
  // same as above, but only for the links from pretty-printed to minified sources
  const prettyPrinted = new Map<ProtocolSourceId, ProtocolSourceId>();

  const urlToFirstSource: Map<ProtocolSourceId, ProtocolSource> = new Map();
  const urlsThatChange: Set<ProtocolSourceId> = new Set();

  protocolSources.forEach(source => {
    const { contentId, generatedSourceIds, kind, sourceId, url } = source;
    const key = keyForSource(source, protocolSourcesById);

    corresponding.add(key, sourceId);

    for (const generatedSourceId of generatedSourceIds || []) {
      original.add(generatedSourceId, sourceId);
    }

    if (kind === "prettyPrinted") {
      assert(
        generatedSourceIds?.length === 1,
        "a pretty-printed source should have exactly one generated source"
      );
      prettyPrinted.set(generatedSourceIds[0], sourceId);
    }

    if (url) {
      if (urlToFirstSource.has(url)) {
        const firstSource = urlToFirstSource.get(url)!;
        const { contentId: prevContentId, kind: prevKind } = firstSource;
        if (kind === prevKind && contentId !== prevContentId) {
          urlsThatChange.add(url);
        }
      } else {
        urlToFirstSource.set(url, source);
      }
    }
  });

  const urlToIndex: Map<string, number> = new Map();

  return protocolSources.map(source => {
    const { contentId, generatedSourceIds, kind, sourceId, url } = source;
    const key = keyForSource(source, protocolSourcesById);

    let contentIdIndex = 0;
    let doesContentIdChange = false;
    if (url) {
      doesContentIdChange = urlsThatChange.has(url);

      const index = urlToIndex.get(url) || 0;
      contentIdIndex = index;
      urlToIndex.set(url, index + 1);
    }

    const isSourceMapped =
      kind === "prettyPrinted"
        ? protocolSourcesById.get(generatedSourceIds![0])!.kind === "sourceMapped"
        : source.kind === "sourceMapped";

    return {
      id: sourceId,
      sourceId,
      kind,
      url,
      contentId,
      contentIdIndex,
      doesContentIdChange,
      isSourceMapped,
      correspondingSourceIds: corresponding.map.get(key)!,
      generated: generatedSourceIds ?? [],
      generatedFrom: original.map.get(sourceId) ?? [],
      prettyPrinted: prettyPrinted.get(sourceId),
      prettyPrintedFrom:
        source.kind === "prettyPrinted" ? generatedSourceIds![0] : undefined,
    };
  });
}

export function getCorrespondingSourceIds(sourcesById: SourcesById, sourceId: SourceId) {
  const source = sourcesById[sourceId];
  return source?.correspondingSourceIds || [sourceId];
}

export const isOriginalSource = (sd: SourceDetails) => {
  return sd.isSourceMapped;
};

export const isPrettyPrintedSource = (sd: SourceDetails) => {
  return !!sd.prettyPrintedFrom;
};

export function getIsOriginalSource(sourcesById: SourcesById, sourceId: SourceId) {
  const sourceDetails = sourcesById[sourceId];
  return sourceDetails != null && isOriginalSource(sourceDetails);
}

export function getIsPrettyPrintedSource(sourcesById: SourcesById, sourceId: SourceId) {
  const sourceDetails = sourcesById[sourceId];
  return sourceDetails != null && isPrettyPrintedSource(sourceDetails);
}

export function getBestSourceMappedSourceId(
  sourcesById: Dictionary<SourceDetails>,
  sourceIds: string[]
) {
  const sourceIdSet = new Set(sourceIds);
  return sourceIds.find(sourceId => {
    const source = sourcesById[sourceId];
    assert(source, `unknown source ${sourceId}`);
    return (
      source.isSourceMapped &&
      !source.generatedFrom.some(originalId => sourceIdSet.has(originalId))
    );
  });
}

export function getBestNonSourceMappedSourceId(
  sourcesById: Dictionary<SourceDetails>,
  sourceIds: string[]
) {
  const sourceIdSet = new Set(sourceIds);
  return sourceIds.find(sourceId => {
    const source = sourcesById[sourceId];
    assert(source, `unknown source ${sourceId}`);
    return (
      !source.isSourceMapped &&
      !source.generatedFrom.some(originalId => sourceIdSet.has(originalId))
    );
  });
}

export function getPreferredSourceId(
  sourcesById: Dictionary<SourceDetails>,
  sourceIds: string[],
  preferredGeneratedSources?: string[]
) {
  const sourceMappedId = getBestSourceMappedSourceId(sourcesById, sourceIds);
  const nonSourceMappedId = getBestNonSourceMappedSourceId(sourcesById, sourceIds);
  if (!sourceMappedId) {
    return nonSourceMappedId;
  }
  if (!nonSourceMappedId) {
    return sourceMappedId;
  }
  if (preferredGeneratedSources?.includes(nonSourceMappedId)) {
    return nonSourceMappedId;
  }
  return sourceMappedId;
}

export function getPreferredLocation(
  sourcesById: SourcesById,
  locations: MappedLocation | undefined
) {
  if (!locations || locations.length === 0) {
    return;
  }

  updateMappedLocation(sourcesById, locations);

  const sourceId = getPreferredSourceId(
    sourcesById,
    locations.map(l => l.sourceId)
  );
  const preferredLocation = locations.find(l => l.sourceId == sourceId);
  assert(preferredLocation, "no preferred location found");
  assert(
    preferredLocation.sourceId ===
      getCorrespondingSourceIds(sourcesById, preferredLocation.sourceId)[0],
    "location.sourceId should be updated to the first corresponding sourceId"
  );
  return preferredLocation;
}

export function getCorrespondingLocations(
  sourcesById: SourcesById,
  location: Location
): Location[] {
  const { column, line, sourceId } = location;
  const sourceIds = getCorrespondingSourceIds(sourcesById, sourceId);
  return sourceIds.map(sourceId => ({
    column,
    line,
    sourceId,
  }));
}

export function updateLocation(sourcesById: SourcesById, location: Location) {
  location.sourceId = getCorrespondingSourceIds(sourcesById, location.sourceId)[0];
}

export function updateMappedLocation(
  sourcesById: SourcesById,
  mappedLocation: MappedLocation | undefined
) {
  if (!mappedLocation) {
    return;
  }
  for (const location of mappedLocation) {
    updateLocation(sourcesById, location);
  }
}

export function getGeneratedLocation(
  sourcesById: Dictionary<SourceDetails>,
  locations: MappedLocation
): Location {
  const location = locations.find(location => {
    const source = sourcesById[location.sourceId];
    return source?.generated.length === 0;
  });
  assert(location, "no generated location found");
  return location || locations[0];
}

export function isLocationBefore(a: SourceLocation, b: SourceLocation) {
  if (a.line < b.line) {
    return true;
  } else if (a.line > b.line) {
    return false;
  } else {
    return a.column <= b.column;
  }
}

export function isSourceMappedSource(
  sourceId: SourceId,
  sourcesById: SourcesById
): boolean {
  const source = sourcesById[sourceId]!;
  assert(source, `Source ${sourceId} not found`);
  return source.isSourceMapped;
}

function isNodeModule(source?: SourceDetails): boolean {
  if (!source?.url) {
    return false;
  }

  return source.url.includes("node_modules");
}

function isModuleFromCdn(source?: SourceDetails): boolean {
  if (!source?.url) {
    return false;
  }

  // This is not an exhaustive list of CDNs.
  return (
    source.url.includes("cdnjs.com") ||
    source.url.includes("jsdelivr.com") ||
    source.url.includes("unpkg.com")
  );
}

export function getSourceIdsByCategory(sourcesById: SourcesById) {
  const sourceIdsWithNodeModules: SourceId[] = [];
  const sourceIdsWithoutNodeModules: SourceId[] = [];

  const allSources = Object.values(sourcesById);

  // Insert sources in order so that original sources are first.
  const compareSources = (a: SourceId, b: SourceId) => {
    const aIsOriginal = isSourceMappedSource(a, sourcesById);
    const bIsOriginal = isSourceMappedSource(b, sourcesById);
    if (aIsOriginal === bIsOriginal) {
      return 0;
    } else if (aIsOriginal) {
      return -1;
    } else {
      return 1;
    }
  };

  const minifiedSources = new Set<SourceId>();
  allSources.forEach(source => {
    if (source.kind === "prettyPrinted" && source.generated.length) {
      minifiedSources.add(source.generated[0]);
    }
  });

  allSources.forEach(source => {
    const sourceId = source.sourceId;

    if (minifiedSources.has(sourceId)) {
      return;
    }

    const correspondingSourceId = getCorrespondingSourceIds(
      sourcesById,
      source.sourceId
    )[0];
    if (correspondingSourceId !== sourceId) {
      return;
    }

    if (!isNodeModule(source) && !isModuleFromCdn(source)) {
      sourceIdsWithoutNodeModules.push(source.id);
    }

    sourceIdsWithNodeModules.push(source.id);
  });

  sourceIdsWithNodeModules.sort(compareSources);
  sourceIdsWithoutNodeModules.sort(compareSources);

  return { sourceIdsWithNodeModules, sourceIdsWithoutNodeModules };
}
