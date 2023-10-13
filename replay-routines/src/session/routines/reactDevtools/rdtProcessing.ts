/* Copyright 2023 Record Replay Inc. */

// React DevTools routine result processing logic

import {
  ExecutionPoint,
  Location,
  TimeStampedPoint,
  NavigationEvent as ReplayNavigationEvent,
  SourceLocation,
} from "@replayio/protocol";

import { Cache, createCache } from "suspense";

import { assert } from "../../../shared/assert";

// These are plain JS files that are being imported at build time,
// so that we can stringify the JS functions and send them to be
// evaluated at runtime. We don't currently have a good way to
// include these files as assets in a backend deployment otherwise.
import {
  FunctionWithPreview,
  formatEventListener,
} from "../reactEventListeners/eventListenerProcessing";
import { ReplayClientInterface } from "../shared/replayClient";
import { CachesCollection } from "../shared/caches/ProtocolDataCaches";
import { SourcesById, getPreferredLocation } from "../shared/sources";
import {
  utfDecodeString,
  utfEncodeString,
  TREE_OPERATION_ADD,
  TREE_OPERATION_REMOVE,
  TREE_OPERATION_REORDER_CHILDREN,
  TREE_OPERATION_UPDATE_TREE_BASE_DURATION,
  TREE_OPERATION_UPDATE_ERRORS_OR_WARNINGS,
  TREE_OPERATION_REMOVE_ROOT,
  TREE_OPERATION_SET_SUBTREE_MODE,
  ElementTypeRoot,
} from "./printOperations";
import { RoutineError } from "../routine";
import {
  compareExecutionPoints,
  isExecutionPointGreaterThan,
  isExecutionPointWithinRange,
} from "../shared/time";
import { FiberDescription } from "./rdtEvaluations";

export interface OperationsInfo {
  point: ExecutionPoint;
  time: number;
  originalOperations: number[];
  deconstructedOperations: DeconstructedOperationsPieces;
  fiberDescriptions?: FiberDescription;
}

interface RootNodeOperation extends TimeStampedPoint {
  type: "root-added" | "root-removed";
  rendererId: number;
  rootId: number;
}

export interface DeconstructedOperationsPieces {
  rendererId: number;
  rootId: number;
  stringTable: string[];
  treeOperations: ParsedReactDevtoolsTreeOperations[];
}

// The React DevTools logic defines a set of "tree operations" that describe
// changes to the contents of the React component tree. Those operations are
// serialized as part of a single large numeric operations array, which is very
// hard to read or work with. This file contains logic to parse that array into
// specific structures with named fields, which are easier to work with, and then
// reconstruct an equivalent numeric operations array based on these structures.
interface TreeOperationAddRootContents {
  nodeType: "root";
  isStrictModeCompliant: boolean;
  profilingFlags: number;
  supportsStrictMode: boolean;
  hasOwnerMetadata: boolean;
}

interface TreeOperationAddNodeContents {
  nodeType: "node";
  parentId: number;
  ownerId: number;
  stringTableIndex: number;
  keyStringTableIndex: number;
}

interface TreeOperationAddBase {
  type: typeof TREE_OPERATION_ADD;
  nodeId: number;
  nodeType: number;
}

interface TreeOperationAddRoot extends TreeOperationAddBase {
  name: "addRoot";
  contents: TreeOperationAddRootContents;
}

interface TreeOperationAddNode extends TreeOperationAddBase {
  name: "addNode";
  contents: TreeOperationAddNodeContents;
}

interface TreeOperationRemove {
  type: typeof TREE_OPERATION_REMOVE;
  name: "remove";
  nodeIds: number[];
}

interface TreeOperationRemoveRoot {
  type: typeof TREE_OPERATION_REMOVE_ROOT;
  name: "removeRoot";
}

interface TreeOperationSetSubtreeMode {
  type: typeof TREE_OPERATION_SET_SUBTREE_MODE;
  name: "setSubtreeMode";
  rootId: number;
  mode: number;
}

interface TreeOperationReorderChildren {
  type: typeof TREE_OPERATION_REORDER_CHILDREN;
  name: "reorderChildren";
  nodeId: number;
  children: number[];
}

interface TreeOperationUpdateTreeBaseDuration {
  type: typeof TREE_OPERATION_UPDATE_TREE_BASE_DURATION;
  name: "updateTreeBaseDuration";
  id: number;
  baseDuration: number;
}

interface TreeOperationUpdateErrorsOrWarnings {
  type: typeof TREE_OPERATION_UPDATE_ERRORS_OR_WARNINGS;
  name: "updateErrorsOrWarnings";
  nodeId: number;
  errors: number;
  warnings: number;
}

export type ParsedReactDevtoolsTreeOperations =
  | TreeOperationAddRoot
  | TreeOperationAddNode
  | TreeOperationRemove
  | TreeOperationRemoveRoot
  | TreeOperationSetSubtreeMode
  | TreeOperationReorderChildren
  | TreeOperationUpdateTreeBaseDuration
  | TreeOperationUpdateErrorsOrWarnings;

export interface MinifiedFunctionDetails {
  functionWithPreview: FunctionWithPreview;
  preferredLocation: Location;
  minifiedName: string;
}

export interface FunctionLocationAndName {
  location: Location;
  originalName: string;
  minifiedName: string;
  url?: string;
}

type FunctionDetailsByLocationCache = Cache<
  [
    locationString: string,
    replayClient: ReplayClientInterface,
    sourcesById: SourcesById,
    preferredLocation: Location,
    functionPreview: FunctionWithPreview,
    minifiedComponentName: string,
    externalMap: Map<string, FunctionLocationAndName>
  ],
  FunctionLocationAndName
>;

export interface RDTCaches {
  functionDetailsByLocation: FunctionDetailsByLocationCache;
}

export function createRDTCaches(cachesCollection: CachesCollection): RDTCaches {
  const functionDetailsByLocation: FunctionDetailsByLocationCache = createCache({
    getKey: ([locationString]) => locationString,
    load: async ([
      locationString,
      replayClient,
      sourcesById,
      preferredLocation,
      functionPreview,
      minifiedComponentName,
      externalMap,
    ]) => {
      // Look up the _original_ function name via scope mapping
      const formattedEventListener = await formatEventListener(
        replayClient,
        "keypress", // doesn't matter, just need a valid event type
        functionPreview.preview,
        sourcesById,
        cachesCollection
      );

      const possibleNames = [
        formattedEventListener?.classComponentName,
        formattedEventListener?.functionName,
        minifiedComponentName,
      ];
      // Don't replace empty strings or missing data
      const originalName = possibleNames.find(n => !!n)!;

      const functionDetails: FunctionLocationAndName = {
        location: preferredLocation,
        originalName,
        minifiedName: minifiedComponentName,
        url: sourcesById[preferredLocation.sourceId]?.url,
      };

      externalMap.set(locationString, functionDetails);

      return functionDetails;
    },
  });

  return {
    functionDetailsByLocation,
  };
}

export function locationToString(location: Location) {
  return `${location.sourceId}:${location.line}:${location.column}`;
}

export async function deriveOriginalComponentDisplayNames(
  sourcesById: SourcesById,
  replayClient: ReplayClientInterface,
  functionReferencesByLocation: Map<string, MinifiedFunctionDetails>,
  rdtCaches: RDTCaches,
  functionDetailsByLocation: Map<string, FunctionLocationAndName>
): Promise<FunctionLocationAndName[]> {
  if (functionReferencesByLocation.size < 1) {
    return [];
  }

  return Promise.all(
    Array.from(functionReferencesByLocation.entries()).map(
      async ([locationString, minifiedFunctionDetails]) => {
        // We already know the "preferred" original source file for
        // this function based on the processing of the evaluation result.
        const {
          functionWithPreview,
          minifiedName,
          preferredLocation,
        } = minifiedFunctionDetails;

        // Look up the original function name via source outlines
        return rdtCaches.functionDetailsByLocation.readAsync(
          locationString,
          replayClient,
          sourcesById,
          preferredLocation,
          functionWithPreview,
          minifiedName,
          functionDetailsByLocation
        );
      }
    )
  );
}

export function deconstructOperationsArray(
  originalOperations: number[]
): DeconstructedOperationsPieces {
  const rendererId = originalOperations[0];
  const rootId = originalOperations[1];

  let i = 2;

  // Reassemble the string table.
  const stringTable: string[] = [
    null as any, // ID = 0 corresponds to the null string.
  ];

  const stringTableSize = originalOperations[i++];
  const stringTableEnd = i + stringTableSize;
  while (i < stringTableEnd) {
    const nextLength = originalOperations[i++];
    const nextString = utfDecodeString(originalOperations.slice(i, i + nextLength));
    stringTable.push(nextString);
    i += nextLength;
  }

  const numericTreeOperations = originalOperations.slice(stringTableEnd);

  const parsedTreeOperations = parseTreeOperations(numericTreeOperations);

  return {
    rendererId,
    rootId,
    stringTable,
    treeOperations: parsedTreeOperations,
  };
}

export function parseTreeOperations(
  treeOperations: number[]
): ParsedReactDevtoolsTreeOperations[] {
  const parsedOperations: ParsedReactDevtoolsTreeOperations[] = [];

  // We're now going to iterate through just the actual
  // tree operations portion of the original operations array
  let i = 0;
  let loopCounter = 0;

  // Iteration logic and index comments copied from `printOperations.ts`
  while (i < treeOperations.length) {
    if (++loopCounter > 100000) {
      throw new RoutineError("TREE_OPERATION_PARSING_INFINITE_LOOP");
    }
    const operation = treeOperations[i];

    switch (operation) {
      case TREE_OPERATION_ADD: {
        const nodeId = treeOperations[i + 1];
        const type = treeOperations[i + 2];

        i += 3;

        if (type === ElementTypeRoot) {
          // Booleans are encoded as 1 or 0
          const isStrictModeCompliant = treeOperations[i++] === 1;
          const profilingFlags = treeOperations[i++];
          const supportsStrictMode = treeOperations[i++] === 1;
          const hasOwnerMetadata = treeOperations[i++] === 1;

          const operation: TreeOperationAddRoot = {
            type: TREE_OPERATION_ADD,
            name: "addRoot",
            nodeId,
            nodeType: type,
            contents: {
              nodeType: "root",
              isStrictModeCompliant,
              profilingFlags,
              supportsStrictMode,
              hasOwnerMetadata,
            },
          };

          parsedOperations.push(operation);
        } else {
          const parentId = treeOperations[i++];
          const ownerId = treeOperations[i++];
          const stringTableIndex = treeOperations[i++];
          const keyStringTableIndex = treeOperations[i++];

          const operation: TreeOperationAddNode = {
            type: TREE_OPERATION_ADD,
            name: "addNode",
            nodeId,
            nodeType: type,
            contents: {
              nodeType: "node",
              stringTableIndex,
              parentId,
              ownerId,
              keyStringTableIndex,
            },
          };

          parsedOperations.push(operation);
        }

        break;
      }
      case TREE_OPERATION_REMOVE: {
        const removeLength = treeOperations[i + 1];
        i += 2;

        const nodeIds: number[] = [];

        for (let removeIndex = 0; removeIndex < removeLength; removeIndex++) {
          const id = treeOperations[i];
          nodeIds.push(id);
          i += 1;
        }

        const operation: TreeOperationRemove = {
          type: TREE_OPERATION_REMOVE,
          name: "remove",
          nodeIds,
        };

        parsedOperations.push(operation);
        break;
      }
      case TREE_OPERATION_REMOVE_ROOT: {
        i += 1;

        const operation: TreeOperationRemoveRoot = {
          type: TREE_OPERATION_REMOVE_ROOT,
          name: "removeRoot",
        };

        parsedOperations.push(operation);
        break;
      }
      case TREE_OPERATION_SET_SUBTREE_MODE: {
        const rootId = treeOperations[i + 1];
        const mode = treeOperations[i + 2];

        i += 3;

        const operation: TreeOperationSetSubtreeMode = {
          type: TREE_OPERATION_SET_SUBTREE_MODE,
          name: "setSubtreeMode",
          rootId,
          mode,
        };

        parsedOperations.push(operation);
        break;
      }
      case TREE_OPERATION_REORDER_CHILDREN: {
        const nodeId = treeOperations[i + 1];
        const numChildren = treeOperations[i + 2];
        i += 3;
        const children = treeOperations.slice(i, i + numChildren);

        i += numChildren;

        const operation: TreeOperationReorderChildren = {
          type: TREE_OPERATION_REORDER_CHILDREN,
          name: "reorderChildren",
          nodeId,
          children,
        };

        parsedOperations.push(operation);
        break;
      }
      case TREE_OPERATION_UPDATE_TREE_BASE_DURATION: {
        const id = treeOperations[i + 1];
        const baseDuration = treeOperations[i + 2];
        // Base duration updates are only sent while profiling is in progress.
        // We can ignore them at this point.
        // The profiler UI uses them lazily in order to generate the tree.
        i += 3;

        const operation: TreeOperationUpdateTreeBaseDuration = {
          type: TREE_OPERATION_UPDATE_TREE_BASE_DURATION,
          name: "updateTreeBaseDuration",
          id,
          baseDuration,
        };

        parsedOperations.push(operation);
        break;
      }
      case TREE_OPERATION_UPDATE_ERRORS_OR_WARNINGS: {
        const nodeId = treeOperations[i + 1];
        const errors = treeOperations[i + 2];
        const warnings = treeOperations[i + 3];

        i += 4;

        const operation: TreeOperationUpdateErrorsOrWarnings = {
          type: TREE_OPERATION_UPDATE_ERRORS_OR_WARNINGS,
          name: "updateErrorsOrWarnings",
          nodeId,
          errors,
          warnings,
        };

        parsedOperations.push(operation);
        break;
      }
      default:
        throw new RoutineError("UNEXPECTED_PARSED_OPERATION_TYPE", {
          operation,
        });
    }
  }

  return parsedOperations;
}

// Given the deconstructed pieces that comprised an operations array
// in readable form, reconstruct the original numeric operations array.
export function reconstructOperationsArray({
  rendererId,
  rootId,
  stringTable,
  treeOperations,
}: DeconstructedOperationsPieces) {
  const finalStringTable = stringTable.slice();
  // The string table likely has the extra `null` placeholder.
  // We need to remove it before encoding.
  if (finalStringTable[0] === null) {
    finalStringTable.shift();
  }

  const reencodedStringTable = finalStringTable
    .map(string => {
      const encoded = utfEncodeString(string);
      return [encoded.length, ...encoded];
    })
    .flat();

  const reencodedTreeOperations = treeOperations
    .map(op => {
      const instructions: number[] = [op.type];

      switch (op.type) {
        case TREE_OPERATION_ADD: {
          const { nodeId, nodeType, contents } = op;
          instructions.push(nodeId, nodeType);

          if (contents.nodeType === "root") {
            const {
              isStrictModeCompliant,
              profilingFlags,
              supportsStrictMode,
              hasOwnerMetadata,
            } = contents;

            instructions.push(
              isStrictModeCompliant ? 1 : 0,
              profilingFlags,
              supportsStrictMode ? 1 : 0,
              hasOwnerMetadata ? 1 : 0
            );
          } else {
            const { stringTableIndex, parentId, ownerId, keyStringTableIndex } = contents;

            instructions.push(parentId, ownerId, stringTableIndex, keyStringTableIndex);
          }
          break;
        }
        case TREE_OPERATION_REMOVE: {
          const { nodeIds } = op;
          instructions.push(nodeIds.length, ...nodeIds);
          break;
        }
        case TREE_OPERATION_REMOVE_ROOT: {
          // No additional fields other than the operation type,
          // since the root ID is already in the operations array
          break;
        }
        case TREE_OPERATION_SET_SUBTREE_MODE: {
          const { rootId, mode } = op;
          instructions.push(rootId, mode);
          break;
        }
        case TREE_OPERATION_REORDER_CHILDREN: {
          const { nodeId, children } = op;
          instructions.push(nodeId, children.length, ...children);
          break;
        }
        case TREE_OPERATION_UPDATE_TREE_BASE_DURATION: {
          const { id, baseDuration } = op;
          instructions.push(id, baseDuration);
          break;
        }
        case TREE_OPERATION_UPDATE_ERRORS_OR_WARNINGS: {
          const { nodeId, errors, warnings } = op;
          instructions.push(nodeId, errors, warnings);
          break;
        }
        default:
          throw new RoutineError("UNEXPECTED_PARSED_OPERATION_TYPE", {
            operationType: (op as any).type,
          });
      }

      return instructions;
    })
    .flat();

  const operations: number[] = [
    // The original renderer ID and root ID
    rendererId,
    rootId,
    // The new string table length, in number of discrete numeric indices (not number of strings)
    reencodedStringTable.length,
    // The entire new string table contents,
    // containing all string length + individual character numeric value groups
    ...reencodedStringTable,
    // All tree operations values
    ...reencodedTreeOperations,
  ];

  return operations;
}

// If the user navigates on the page, React won't send any kind of an update
// to indicate that the root has been removed. or the tree should have been cleared out.
// Since operations are additive over time, this causes the component tree to become incorrect.
// As an example, hitting F5 twice to reload the page would show 3 tree roots instead of 1,
// since it sees two more "add root" operations, but no "remove root" operations.
// To make up for this, we can use our knowledge of page navigation events to insert
// fake "remove these roots" operations at the right points in time, to effectively reset
// the component tree.
// TODO [FE-1667] This does not handle in-iframe navigations yet
export function insertRootRemovalOpsForNavEvents(
  meaningfulOperations: OperationsInfo[],
  navigationEvents: ReplayNavigationEvent[]
) {
  const rootNodeEvents: RootNodeOperation[] = [];

  const updatedOperations = meaningfulOperations.slice();

  // Find every time that a React root was added or removed
  for (const { point, time, deconstructedOperations } of meaningfulOperations) {
    const {
      rendererId,
      rootId,
      treeOperations: parsedOperations,
    } = deconstructedOperations;

    for (const op of parsedOperations) {
      if (op.type === TREE_OPERATION_ADD && op.contents.nodeType === "root") {
        rootNodeEvents.push({
          type: "root-added",
          rendererId,
          rootId,
          point,
          time,
        });
      } else if (op.type == TREE_OPERATION_REMOVE_ROOT) {
        rootNodeEvents.push({
          type: "root-removed",
          rendererId,
          rootId,
          point,
          time,
        });
      }
    }
  }

  // Track which roots are active over time as the recording progresses
  let activeRoots: Map<number, Set<number>> = new Map();
  let previousNavEventPoint: ExecutionPoint = "0";

  for (const navEvent of navigationEvents) {
    // check to see what the final set of roots is since the last time we navigated
    const rootEventsInTimeframe = rootNodeEvents.filter(({ point }) =>
      isExecutionPointWithinRange(point, previousNavEventPoint, navEvent.point)
    );

    for (const rootEvent of rootEventsInTimeframe) {
      const { rendererId, rootId } = rootEvent;

      if (!activeRoots.has(rendererId)) {
        activeRoots.set(rendererId, new Set());
      }
      const activeRootsForRenderer = activeRoots.get(rendererId)!;
      if (rootEvent.type === "root-added") {
        activeRootsForRenderer.add(rootId);
      } else {
        activeRootsForRenderer.delete(rootId);
      }
    }

    // There seems to be a mismatch between our nav events
    // and whether a page actually _did_ refresh entirely.
    // To avoid inserting bogus "remove root" ops, check to see
    // if any of the later operations use these roots.
    // If so, we can assume that the page did not actually refresh.
    const allOpsAfterNavEvent = meaningfulOperations.filter(p =>
      isExecutionPointGreaterThan(p.point, navEvent.point)
    );

    let anyRootsUsedLater = false;

    for (const [rendererId, activeRootsForRenderer] of activeRoots.entries()) {
      for (const activeRoot of activeRootsForRenderer) {
        const rootUsedLater = allOpsAfterNavEvent.some(
          p =>
            p.deconstructedOperations.rendererId === rendererId &&
            p.deconstructedOperations.rootId === activeRoot
        );
        if (rootUsedLater) {
          anyRootsUsedLater = true;
          break;
        }
      }
    }

    if (anyRootsUsedLater) {
      // This nav event must be a false positive.
      // We can't remove any roots here.
      continue;
    }

    // Assume that every nav wipes out the page entirely.
    // TODO This doesn't deal with iframes yet - not sure how to handle iframe navs?
    for (const [rendererId, activeRootsForRenderer] of activeRoots.entries()) {
      for (const activeRoot of activeRootsForRenderer) {
        const removeRootOp: TreeOperationRemoveRoot = {
          type: TREE_OPERATION_REMOVE_ROOT,
          name: "removeRoot",
        };

        updatedOperations.push({
          point: navEvent.point,
          time: navEvent.time,
          originalOperations: [],
          deconstructedOperations: {
            rendererId,
            rootId: activeRoot,
            stringTable: [],
            treeOperations: [removeRootOp],
          },
        });
      }
    }

    previousNavEventPoint = navEvent.point;
    // Reset the active roots, as the whole page refreshed
    activeRoots = new Map();
  }

  // Ensure any added root removal ops got sorted properly
  updatedOperations.sort((a, b) => compareExecutionPoints(a.point, b.point));

  return updatedOperations;
}

// The RDT internals generate fiber IDs when a node is added, and track those
// IDs in an internal `fiberToIDsMap`. When a node is removed, it's removed from the map.
// Later, when a node is unmounted, the unmount logic checks to see if the ID exists,
// and bails out of the unmount if it doesn't.  This works because `fiberToIDsMap` is
// persistent over the lifetime of the in-page extension logic and tracks changes over time.
// On top of that, React will "simulated unmount" some Suspense or Offscreen children initially,
// then truly unmount them later.
// The RDT internals normally handle the first unmount, but bail out of the second.
//
// Unfortunately, our routine breaks that assumption. `runEvaluation` will break the points
// into batches, and re-inject the RDT bundle into the first point of each batch.
// That means that every batch has a _different_ `fiberToIDsMap` instance, and so it's possible
// that we end up with a duplicate "remove node X" operation that shouldn't be there.
//
// To work around this, we can filter out any duplicate "remove node X" operations, by doing our
// own bookkeeping to track which nodes got added or removed from the tree over time.
// I don't like having to do this, but it's the best I can come up with for now.
export function filterDuplicateNodeRemovalOperations(
  multiCommitOperations: OperationsInfo[]
): OperationsInfo[] {
  type NodesByRoot = Map<number, Set<number>>;
  type RootsByRenderer = Map<number, NodesByRoot>;

  // Keep running track of all the nodes that appear to be in the UI
  // as we iterate through each commit's operations.
  // This will let us detect and fix up mismatches such as a node that
  // was removed twice due to `runEvaluation` breaking the evaluated points
  // into batches and resetting the RDT internal data structures.
  const rootsByRenderer: RootsByRenderer = new Map();

  return multiCommitOperations.map(entry => {
    const {
      rendererId,
      rootId,
      treeOperations: parsedOperations,
    } = entry.deconstructedOperations;

    const newTreeOperations: ParsedReactDevtoolsTreeOperations[] = [];

    // Semi-map over the operations, but possibly skip some REMOVE entries,
    // and track active component nodes as we go.
    for (const treeOp of parsedOperations) {
      switch (treeOp.type) {
        case TREE_OPERATION_ADD: {
          const { nodeId, contents } = treeOp;

          if (contents.nodeType === "root") {
            let rootsForRenderer;
            // Fill in the renderer/root structures as we go
            if (!rootsByRenderer.has(rendererId)) {
              rootsForRenderer = new Map();
              rootsByRenderer.set(rendererId, rootsForRenderer);
            } else {
              rootsForRenderer = rootsByRenderer.get(rendererId)!;
            }

            // List the root itself as a parent for checking purposes
            const nodesForRoot = new Set([nodeId]);
            rootsForRenderer.set(rootId, nodesForRoot);
          } else {
            const rootsForRenderer = rootsByRenderer.get(rendererId)!;
            const nodesForRoot = rootsForRenderer?.get(rootId);

            if (!nodesForRoot) {
              throw new RoutineError(`UNEXPECTED_MISSING_ROOT`);
            }

            nodesForRoot.add(nodeId);
          }
          newTreeOperations.push(treeOp);
          break;
        }
        case TREE_OPERATION_REMOVE: {
          const { nodeIds } = treeOp;
          const rootsForRenderer = rootsByRenderer.get(rendererId)!;
          const nodesForRoot = rootsForRenderer?.get(rootId);

          if (!nodesForRoot) {
            // Mismatch, doesn't look like this root exists.
            // Might be because of a synthesized root removal from a nav event.
            throw new RoutineError(`UNEXPECTED_MISSING_ROOT`);
          }

          const nodesThatCanBeRemoved = nodeIds.filter(nodeId => {
            const canRemoveNode = nodesForRoot.has(nodeId);
            return canRemoveNode;
          });

          for (const nodeId of nodesThatCanBeRemoved) {
            nodesForRoot.delete(nodeId);
          }

          // If we end up with 0 nodes, we can just omit this operation entirely
          if (nodesThatCanBeRemoved.length > 0) {
            newTreeOperations.push({
              ...treeOp,
              nodeIds: nodesThatCanBeRemoved,
            });
          }

          break;
        }
        case TREE_OPERATION_REMOVE_ROOT: {
          const nodesByRoot = rootsByRenderer.get(rendererId)!;
          nodesByRoot.delete(rootId);
          break;
        }
        default: {
          newTreeOperations.push(treeOp);
        }
      }
    }

    return {
      ...entry,
      deconstructedOperations: {
        ...entry.deconstructedOperations,
        treeOperations: newTreeOperations,
      },
    };
  });
}

function isTreeAddNodeOperation(
  op: ParsedReactDevtoolsTreeOperations
): op is TreeOperationAddNode {
  return op.type === TREE_OPERATION_ADD && op.contents.nodeType === "node";
}

export function rewriteOperationsStringTable(
  multiCommitOperations: OperationsInfo[],
  sourcesById: SourcesById,
  allFiberIdsToFunctionReferences: Map<number, FunctionWithPreview>,
  functionDetailsByLocation: Map<string, FunctionLocationAndName>,
  fiberIdsToBuiltinComponentNames: Map<number, string>
) {
  const fiberIdsToComponentNames = new Map<number, string>();

  const operationsWithRewrittenComponentNames = multiCommitOperations.map(entry => {
    const {
      stringTable,
      treeOperations: parsedOperations,
    } = entry.deconstructedOperations;

    // Avoid traversing an array with `.findIndex()` every time
    const newStringTableMap = new Map<string | null, number>();
    newStringTableMap.set(null, 0);
    let nextNewStringTableIndex = 1;

    function getOrInsertStringTableEntry(s: string) {
      // Recreate the string table as we go.
      // Each time we see a new string, we add it to the map.
      // This is effectively an `arr.push()`, but O(1) for lookups.
      let newStringTableIndex: number;
      if (newStringTableMap.has(s)) {
        newStringTableIndex = newStringTableMap.get(s)!;
      } else {
        newStringTableIndex = nextNewStringTableIndex++;
        newStringTableMap.set(s, newStringTableIndex);
      }
      return newStringTableIndex;
    }

    const rewrittenParsedOperations: ParsedReactDevtoolsTreeOperations[] = parsedOperations.map(
      op => {
        if (!isTreeAddNodeOperation(op)) {
          return op;
        }

        const { nodeId, contents } = op;

        const { stringTableIndex, keyStringTableIndex } = contents;

        // Try to replace minified component display names with the original
        // names from the sourcemapped files if possible.
        // Component names only get used  in TREE_OPERATION_ADD operations.

        // Look up the display name RDT calculated from the original string table
        const originalDisplayName = stringTable[stringTableIndex];

        let newDisplayName = originalDisplayName;
        const functionReference = allFiberIdsToFunctionReferences.get(nodeId);

        let sourcemappedName: string | undefined = undefined;

        if (functionReference) {
          const preferredLocation = getPreferredLocation(
            sourcesById,
            functionReference.preview.functionLocation!
          );
          assert(preferredLocation, "Should have a preferred location");
          const locationString = locationToString(preferredLocation);
          sourcemappedName = functionDetailsByLocation.get(locationString)?.originalName;
        } else if (fiberIdsToBuiltinComponentNames.has(nodeId)) {
          sourcemappedName = fiberIdsToBuiltinComponentNames.get(nodeId);
        }

        const isAnonymousFunction = originalDisplayName === "Anonymous";
        const isProbablyMinified = originalDisplayName && originalDisplayName.length <= 3;
        const hasNoDisplayName = originalDisplayName === null;

        // Replace the original (potentially minified) display names
        // with the names from the original source files.
        // We also want to replace "Anonymous", which the RDT logic uses
        // if there was no function name (like an inlined arrow function).
        // Preserve names like "Connect(xyz)" for now and ignore nulls.
        // It would take too much effort to rewrite them,
        // plus we don't generally have function references for those anyway.
        if (
          sourcemappedName &&
          (isAnonymousFunction || isProbablyMinified || hasNoDisplayName)
        ) {
          // Occasionally I see cases where the new name is something like "60673".
          // This might come from Webpack module organization? Skip those.
          const newNameIsJustNumbers = /^\d+$/.test(sourcemappedName);
          if (sourcemappedName !== "constructor" && !newNameIsJustNumbers) {
            newDisplayName = sourcemappedName;
          }
        }

        // The component's display name goes in the string table
        const newDisplayNameStringTableIndex = getOrInsertStringTableEntry(
          newDisplayName
        );

        if (!fiberIdsToComponentNames.has(nodeId)) {
          fiberIdsToComponentNames.set(nodeId, newDisplayName);
        }

        // And so does the key, which we can just copy over as-is (including `null`)
        const keyString = stringTable[keyStringTableIndex];
        const newKeyStringTableIndex = getOrInsertStringTableEntry(keyString);

        return {
          ...op,
          contents: {
            ...op.contents,
            stringTableIndex: newDisplayNameStringTableIndex,
            keyStringTableIndex: newKeyStringTableIndex,
          },
        };
      }
    );

    // Technically there's a `null` in here, but convince TS there isn't
    const rewrittenStringTable = Array.from(newStringTableMap.keys()) as string[];

    return {
      ...entry,
      deconstructedOperations: {
        ...entry.deconstructedOperations,
        stringTable: rewrittenStringTable,
        treeOperations: rewrittenParsedOperations,
      },
    };
  });

  return { operationsWithRewrittenComponentNames, fiberIdsToComponentNames };
}

// https://stackoverflow.com/a/74399506/62937
const htmlElements = new Set(
  `a,abbr,acronym,abbr,address,applet,embed,object,area,article
,aside,audio,b,base,basefont,bdi,bdo,big,blockquote,body,br,button,canvas,caption,center,cite
,code,col,colgroup,data,datalist,dd,del,details,dfn,dialog,dir,ul,div,dl,dt,em,embed,fieldset
,figcaption,figure,font,footer,form,frame,frameset,h1,h2,h3,h4,h5,h6,head,header,hr,html,i,iframe,img
,input,ins,kbd,label,legend,li,link,main,map,mark,meta,meter,nav,noframes,noscript,object,ol
,optgroup,option,output,p,param,path,picture,pre,progress,q,rp,rt,ruby,s,samp,script,section,select
,small,source,span,strike,del,s,strong,style,sub,summary,sup,svg,table,tbody,td,template,textarea
,tfoot,th,thead,time,title,tr,track,tt,u,ul,var,video,wbr`.split(",")
);

const reTagName = /<(?<tag>.+?) /;

// WIP - Still playing with this idea locally
export function diffActualVsCalculatedPrintedComponentTrees(
  actualTree: string,
  calculatedTree: string
) {
  const actualTreeLines = actualTree.split("\n");
  const calculatedTreeLines = calculatedTree.split("\n");

  // The actual tree _should_ always the shorter one, because
  // the calculated tree includes host DOM nodes

  let loopCounter = 0;

  let actualIdx = 0;
  let calculatedIdx = 0;

  while (
    actualIdx < actualTreeLines.length &&
    calculatedIdx < calculatedTreeLines.length
  ) {
    if (++loopCounter > 100000) {
      throw new Error("Infinite loop detected");
    }

    const actualLine = actualTreeLines[actualIdx].trim();
    const calculatedLine = calculatedTreeLines[calculatedIdx].trim();

    if (actualLine === calculatedLine) {
      actualIdx++;
      calculatedIdx++;
      continue;
    }

    const actualTagName = actualLine.match(reTagName)?.groups?.tag;
    const calculatedTagName = calculatedLine.match(reTagName)?.groups?.tag;

    if (!actualTagName || !calculatedTagName) {
      throw new Error("Could not find tag name");
    }

    if (htmlElements.has(actualTagName) || actualTagName === "Fragment") {
      // The actual tree includes host DOM nodes and Fragments, so skip over them
      actualIdx++;
      continue;
    }
  }
}

export function printComponentDescriptionTree(
  description: FiberDescription,
  lines: string[],
  isRoot: boolean,
  printFullTree: boolean,
  fiberIdsToComponentNames: Map<number, string>,
  indent = 0
) {
  let nextIndent = indent + 1;
  const {
    id,
    displayName: minifiedDisplayName,
    key,
    etype,
    filtered,
    children,
  } = description;
  const displayName = fiberIdsToComponentNames.get(id) ?? minifiedDisplayName;

  // yeah, mutate this, and do horribly bad things to force
  // a semi-sorted key order for stringification purposes
  const keysToRewrite: (keyof FiberDescription)[] = [
    "displayName",
    "key",
    "children",
    "etype",
    "filtered",
  ];

  for (const key of keysToRewrite) {
    delete description[key];
  }

  Object.assign(description, {
    displayName: minifiedDisplayName,
    originalDisplayName: displayName,
    key,
    etype,
    filtered,
    children,
  });

  if (isRoot) {
    lines.push(`[root (${description.id})]`);
  } else {
    if (printFullTree || !filtered) {
      // format a component like: <ComponentName (123) key="key">, with appropriate indent
      const prefix = "".padStart(indent * 2, " ");
      const keyString = key !== null ? ` key="${key}"` : "";
      const line = `${prefix}<${displayName} (${id})${keyString} >`;

      lines.push(line);
    } else {
      nextIndent = indent;
    }
  }

  for (const child of children) {
    printComponentDescriptionTree(
      child,
      lines,
      false,
      printFullTree,
      fiberIdsToComponentNames,
      nextIndent
    );
  }
}

export async function didReactDOMExecute(
  replayClient: ReplayClientInterface,
  cachesCollection: CachesCollection,
  sourcesById: SourcesById
): Promise<boolean> {
  const reactDomSources = Object.values(sourcesById).filter(
    source => source?.url?.includes("react-dom.") && source?.kind !== "prettyPrinted"
  );

  if (reactDomSources.length === 0) {
    return false;
  }

  const didSourcesExecute = await Promise.all(
    reactDomSources.map(async source => {
      if (!source) {
        return false;
      }

      const [
        ,
        breakablePositionsByLine,
      ] = await cachesCollection.breakpointPositionsCache.readAsync(
        replayClient,
        source.id
      );

      const firstBreakableLine = [...breakablePositionsByLine.values()][0];

      const firstBreakablePosition: SourceLocation = {
        line: firstBreakableLine.line,
        column: firstBreakableLine.columns[0],
      };

      const hits = await replayClient.findPoints({
        kind: "location",
        location: {
          ...firstBreakablePosition,
          sourceId: source.id,
        },
      });

      return hits.length > 0;
    })
  );

  const didAtLeastOneReactSourceExecute = didSourcesExecute.some(
    didExecute => didExecute
  );

  return didAtLeastOneReactSourceExecute;
}
