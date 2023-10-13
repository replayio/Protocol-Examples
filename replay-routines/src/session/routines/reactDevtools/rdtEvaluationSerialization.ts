/* Copyright 2023 Record Replay Inc. */

// React DevTools routine logic for serializing and deserializing
// data from the `runEvaluation` expressions:
// - React DevTools operations arrays
// - Mapping of component references to display names and fiber IDs
// - Mapping of built-in component types (Context, ForwardRef, etc.) to display names

import {
  ExecutionPoint,
  PauseData,
  Property,
  Object as ProtocolObject,
  Value as ProtocolValue,
} from "@replayio/protocol";

import { ThrowError, assert } from "../../../shared/assert";
import { Context } from "../../../shared/context";
import { RoutineError } from "../routine";

// These are plain JS files that are being imported at build time,
// so that we can stringify the JS functions and send them to be
// evaluated at runtime. We don't currently have a good way to
// include these files as assets in a backend deployment otherwise.
import { ConstructedPauseData } from "../../../shared/pauseData";
import {
  FunctionWithPreview,
  isFunctionWithPreview,
} from "../reactEventListeners/eventListenerProcessing";
import { SourcesById, getPreferredLocation } from "../shared/sources";
import {
  FunctionLocationAndName,
  MinifiedFunctionDetails,
  OperationsInfo,
  deconstructOperationsArray,
  locationToString,
} from "./rdtProcessing";
import {
  ChunksArray,
  FetchOperationsResult,
  UnknownFunction,
  RDTComponentFunctionDetailsPerPoint,
  RDTSerializedResultContents,
} from "./rdtEvaluations";
import { getPropertyByName, inspectDeep } from "../shared/utils";
import {
  CONCURRENT_MODE_NUMBER,
  CONCURRENT_MODE_SYMBOL_STRING,
  CONTEXT_NUMBER,
  CONTEXT_SYMBOL_STRING,
  DEPRECATED_ASYNC_MODE_SYMBOL_STRING,
  PROFILER_NUMBER,
  PROFILER_SYMBOL_STRING,
  PROVIDER_NUMBER,
  PROVIDER_SYMBOL_STRING,
  SCOPE_NUMBER,
  SCOPE_SYMBOL_STRING,
  SERVER_CONTEXT_SYMBOL_STRING,
  STRICT_MODE_NUMBER,
  STRICT_MODE_SYMBOL_STRING,
} from "./ReactSymbols";
import { compareExecutionPoints } from "../shared/time";

export interface ProcessedRDTResults {
  allOperations: OperationsInfo[];
  functionDetailsByLocation: Map<string, FunctionLocationAndName>;
  allFiberIdsToFunctionReferences: Map<number, FunctionWithPreview>;
  fiberIdsToBuiltinComponentNames: Map<number, string>;
  functionReferencesByLocation: Map<string, MinifiedFunctionDetails>;
}

// Recreates a possibly-chunked string at the head of the chunks array,
// including rejoining 10K-character chunks if necessary,
// It removes those from the `chunks` array (mutating!), and returns the string
function deserializeChunkedString(chunks: Property[]): string {
  let numStringChunks = 1;
  if (typeof chunks[0].value === "number") {
    const numChunksProp = chunks.shift()!;
    numStringChunks = numChunksProp.value;
  }
  const stringChunks = chunks.splice(0, numStringChunks);

  let str = "";
  for (const stringChunkProp of stringChunks) {
    str += stringChunkProp.value;
  }

  return str;
}

// Ported version from the React DevTools source,
// converted to look at a Replay Protocol prop object
// Original: https://github.com/facebook/react/blob/8ec962d825fc948ffda5ab863e639cd4158935ba/packages/react-devtools-shared/src/backend/renderer.js#L375
function getTypeSymbol(type: ProtocolObject): string | number | undefined {
  const $$typeof = getPropertyByName(type, "$$typeof");

  let typeSymbol: string | number | undefined;

  if ($$typeof) {
    typeSymbol = $$typeof.symbol ?? $$typeof.value;
  }

  return typeSymbol;
}

// Ported from `getDisplayNameForFiber` in the RDT backend logic
// Tries to determine an appropriate display name for built-in component
// types such as Context, ForwardRef, etc.
// Original: https://github.com/facebook/react/blob/8ec962d825fc948ffda5ab863e639cd4158935ba/packages/react-devtools-shared/src/backend/renderer.js#L496-L537
function getDisplayNameForNonFunctionFiber(
  fiberType: ProtocolObject,
  pauseData: ConstructedPauseData
) {
  const typeSymbol = getTypeSymbol(fiberType);

  switch (typeSymbol) {
    case CONCURRENT_MODE_NUMBER:
    case CONCURRENT_MODE_SYMBOL_STRING:
    case DEPRECATED_ASYNC_MODE_SYMBOL_STRING:
      return null;
    case PROVIDER_NUMBER:
    case PROVIDER_SYMBOL_STRING: {
      // 16.3.0 exposed the context object as "context"
      // PR #12501 changed it to "_context" for 16.3.1+
      // NOTE Keep in sync with inspectElementRaw()
      const _contextProp = getPropertyByName(fiberType, "_context");
      const contextProp = getPropertyByName(fiberType, "context");

      const matchingProp = _contextProp ?? contextProp;
      const contextObjectId = matchingProp?.object;

      let displayName = "";
      if (contextObjectId) {
        const contextObjectParent = pauseData.objects.get(contextObjectId);
        if (contextObjectParent?.objectId) {
          const contextObject = pauseData.objects.get(contextObjectParent.objectId);

          if (contextObject) {
            const displayNameProp = getPropertyByName(contextObject, "displayName");
            displayName = displayNameProp?.value ?? "";
          }
        }
      }

      return `${displayName || "Context"}.Provider`;
    }

    case CONTEXT_NUMBER:
    case CONTEXT_SYMBOL_STRING:
    case SERVER_CONTEXT_SYMBOL_STRING: {
      // 16.3-16.5 read from "type" because the Consumer is the actual context object.
      // 16.6+ should read from "type._context" because Consumer can be different (in DEV).
      // NOTE Keep in sync with inspectElementRaw()
      // resolvedContext = fiber.type._context || fiber.type;
      const displayNameProp = getPropertyByName(fiberType, "displayName");
      const displayName = displayNameProp?.value ?? "";
      // NOTE: TraceUpdatesBackendManager depends on the name ending in '.Consumer'
      // If you change the name, figure out a more resilient way to detect it.
      return `${displayName || "Context"}.Consumer`;
    }
    case STRICT_MODE_NUMBER:
    case STRICT_MODE_SYMBOL_STRING:
      return null;
    case PROFILER_NUMBER:
    case PROFILER_SYMBOL_STRING:
      return `Profiler`;
    case SCOPE_NUMBER:
    case SCOPE_SYMBOL_STRING:
      return "Scope";
    default:
      // Unknown element type.
      // This may mean a new element type that has not yet been added to DevTools.
      return null;
  }
}

export type RDTEvaluationResult = {
  point: ExecutionPoint;
  time: number;
  value: ProtocolValue;
  data: PauseData;
};

// Reconstructs the serialized contents from each point's evaluation results:
// the numeric operations array, and details on the minified display name
// and fiber IDs that we captured for each component function reference.
export async function processRDTEvaluationResults(
  pointEvalResults: Array<RDTEvaluationResult>,
  sourcesById: SourcesById,
  cx: Context
): Promise<ProcessedRDTResults> {
  const allOperations: OperationsInfo[] = [];

  const allFiberIdsToFunctionReferences = new Map<number, FunctionWithPreview>();
  const fiberIdsToBuiltinComponentNames = new Map<number, string>();
  const functionDetailsByLocation = new Map<string, FunctionLocationAndName>();

  const functionReferencesByLocation = new Map<string, MinifiedFunctionDetails>();

  pointEvalResults.sort((a, b) => compareExecutionPoints(a.point, b.point));

  for (const result of pointEvalResults) {
    const { value, point, time, data } = result;
    if (!value.object) {
      ThrowError("UnexpectedReactDevtoolsRoutineFailure", {
        point: point,
        runtimeError: value,
      });
    }

    const pauseData = new ConstructedPauseData();
    pauseData.addPauseData(data);

    const obj = pauseData.objects.get(value.object);

    assert(obj, "unexpected undefined obj");
    assert(obj.preview, "unexpected missing preview");
    assert(obj.preview.properties, "unexpected missing preview properties");

    // Reassemble the serialized pieces returned from the evaluation.

    // Rather than try to maintain a series of cumulative indices,
    // treat the properties array as a queue. We can read a size value,
    // then splice off that many items.

    // Start by safety-checking all properties in the array to eliminate any
    // possible Symbol fields or other non-integer indices.
    let nextIndex = 0;
    const remainingProperties = obj.preview.properties.filter(prop => {
      const expectedIndex = Number.parseInt(prop.name);

      if (prop.isSymbol || !Number.isInteger(expectedIndex)) {
        // Array preview won't normally hit this case, but since this code is
        // currently running on the user's actual page content, they may have
        // overloaded properties on Array.prototype that could show up here.
        return false;
      }

      assert(expectedIndex === nextIndex, "unexpected out-of-order preview", {
        nextIndex,
        expectedIndex,
      });

      nextIndex++;
      return true;
    });

    const operationsString = deserializeChunkedString(remainingProperties);

    if (!operationsString) {
      throw new RoutineError("EMPTY_SERIALIZED_RESULT");
    }

    const { operations, error, stack, serializedTree, messages } = JSON.parse(
      operationsString
    ) as RDTSerializedResultContents;

    // Local debug only. Depends on the DEBUG_LOG_MESSAGES
    // flag in `rdtEvaluation.ts`, otherwise the field is empty.
    if (messages?.length) {
      console.log("Messages: ", inspectDeep({ point, time }), inspectDeep(messages));
    }

    if (typeof error === "string") {
      cx.logger.debug("ReactRoutineExpectedError", {
        error,
        stack,
      });
      throw new RoutineError(error);
    }

    if (!operations || operations.length < 1) {
      continue;
    }

    for (const numericOperations of operations) {
      const deconstructedOperations = deconstructOperationsArray(numericOperations);

      allOperations.push({
        point,
        time,
        originalOperations: numericOperations,
        deconstructedOperations,
        fiberDescriptions: serializedTree ? JSON.parse(serializedTree) : undefined,
      });
    }

    // Now try to deserialize the component function details
    if (remainingProperties.length === 0) {
      continue;
    }

    // Determine how many serialized key/value pairs are in the array
    const functionDetailsSizeProp = remainingProperties.shift()!;
    const functionDetailsSize: number = functionDetailsSizeProp?.value ?? 0;

    for (let i = 0; i < functionDetailsSize; i++) {
      // Always shift off all the chunks related to this property
      // before we consider skipping forward
      const functionReferenceKeyProp = remainingProperties.shift();
      const functionDetailsString = deserializeChunkedString(remainingProperties);

      const previewObjectId = functionReferenceKeyProp?.object;
      if (!previewObjectId) {
        continue;
      }
      const functionWithPreview = pauseData.objects.get(previewObjectId);

      // Ignore anything that isn't specifically a function preview
      if (!functionWithPreview || !isFunctionWithPreview(functionWithPreview)) {
        continue;
      }

      // Any time we saw a fiber, we should have created this details object,
      // even if the display name ends up being empty.
      if (!functionDetailsString) {
        throw new RoutineError("EMPTY_SERIALIZED_RESULT");
      }

      const functionLocation = getPreferredLocation(
        sourcesById,
        functionWithPreview.preview!.functionLocation
      );

      if (!functionLocation) {
        continue;
      }

      const locationString = locationToString(functionLocation);

      // We now have the minified display name of this function,
      // as well as a list of all fiber IDs that reference it.
      const functionDetails = JSON.parse(
        functionDetailsString
      ) as RDTComponentFunctionDetailsPerPoint;

      if (!functionReferencesByLocation.has(locationString)) {
        // The display name found by the RDT logic is almost always
        // identical to the minified function name, but just in case
        const minifiedName =
          functionDetails.minifiedDisplayName ||
          functionWithPreview.preview!.functionName!;

        functionReferencesByLocation.set(locationString, {
          functionWithPreview,
          preferredLocation: functionLocation,
          minifiedName,
        });
      }

      // We fetched a map of component functions to a list of fiber IDs
      // that used that component as `fiber.type`.
      // Invert the list so we can look up a function reference from
      // a fiber ID, which is what we'll see in the operations arrays
      for (const fiberId of functionDetails.fiberIds) {
        if (allFiberIdsToFunctionReferences.has(fiberId)) {
          // Every fiber ID should have a consistent function reference.
          const dupe = allFiberIdsToFunctionReferences.get(fiberId)!;

          const secondLocation = getPreferredLocation(
            sourcesById,
            dupe.preview!.functionLocation
          )!;
          const secondLocationString = locationToString(secondLocation);
          assert(
            locationString === secondLocationString,
            `Unexpected mismatched locations for fiber ID: ${fiberId}, ${locationString} !== ${secondLocationString}`
          );
        } else {
          allFiberIdsToFunctionReferences.set(fiberId, functionWithPreview);
        }
      }
    }

    const otherFunctionTypesProp = remainingProperties.shift()!;
    const otherFunctionTypesSize: number = otherFunctionTypesProp?.value ?? 0;

    for (let i = 0; i < otherFunctionTypesSize; i++) {
      // Always shift off all the chunks related to this property
      // before we consider skipping forward
      const fiberTypeProp = remainingProperties.shift();
      const fiberDetailsString = deserializeChunkedString(remainingProperties);

      const previewObjectId = fiberTypeProp?.object;
      if (!previewObjectId) {
        continue;
      }
      const fiberType = pauseData.objects.get(previewObjectId);
      if (!fiberType) {
        continue;
      }

      const fiberDetails = JSON.parse(
        fiberDetailsString
      ) as RDTComponentFunctionDetailsPerPoint;

      const displayName =
        getDisplayNameForNonFunctionFiber(fiberType, pauseData) ?? "Anonymous";

      for (const fiberId of fiberDetails.fiberIds) {
        fiberIdsToBuiltinComponentNames.set(fiberId, displayName);
      }
    }

    assert(
      remainingProperties.length === 0,
      `unexpected remaining serialized map properties (${remainingProperties.length}): `
    );
  }

  return {
    allOperations,
    functionDetailsByLocation,
    allFiberIdsToFunctionReferences,
    fiberIdsToBuiltinComponentNames,
    functionReferencesByLocation,
  };
}

// This function will be evaluated in the browser via an expression
// same as the functions in `rdtEvaluations.ts`. It's put in this file
// to keep the serialization/deserialization logic together.
export function serializeFetchOperationsResult(
  fetchOperationResult: FetchOperationsResult
) {
  // Work around Chromium string 10K character limit, by:
  // - Taking the `potentially-large `JSON.stringify()` string
  // - Splitting it into chunks of 9999 characters
  // - Returning that as the evaluation result
  // - Reassembling the chunks into a single string in the result handler

  // Gotta define this inline, since this whole function
  // will be evaluated
  function splitStringIntoChunks(allChunks: ChunksArray, str: string) {
    // Split the stringified data into chunks
    const stringChunks: string[] = [];
    for (let i = 0; i < str.length; i += 9999) {
      stringChunks.push(str.slice(i, i + 9999));
    }

    // If there's more than one string chunk, save its size
    if (stringChunks.length > 1) {
      allChunks.push(stringChunks.length);
    }

    for (const chunk of stringChunks) {
      allChunks.push(chunk);
    }
    return stringChunks.length;
  }

  function serializeMapChunks(
    numChunksBeforeMapContents: number,
    functionDetailsMap: Map<UnknownFunction, any>
  ) {
    const mapKeyValueChunks: ChunksArray = [];
    let numAddedKeyValuePairs = 0;

    // Add each key/value pair from the component details map
    for (const [functionReferenceKey, functionDetailsValue] of functionDetailsMap) {
      const thisEntryChunks: ChunksArray = [];
      thisEntryChunks.push(functionReferenceKey);
      const stringifiedDetails = JSON.stringify(functionDetailsValue);

      // Unlikely that a list of fiber IDs in one point would be
      // over 10K characters, but better safe than sorry
      splitStringIntoChunks(thisEntryChunks, stringifiedDetails);

      const runningTotalChunks =
        numChunksBeforeMapContents + mapKeyValueChunks.length + thisEntryChunks.length;

      if (runningTotalChunks >= MAX_PREVIEWABLE_PROPERTIES) {
        // We can't add this entry without going over the limit,
        // so bail out. We just won't be able to format anything
        // after this entry.
        break;
      }

      mapKeyValueChunks.push(...thisEntryChunks);
      numAddedKeyValuePairs++;
    }
    return { numAddedKeyValuePairs, mapKeyValueChunks };
  }

  // Carefully serialize both the stringified operations data and the
  // component map, so that we can reassemble them later.

  const operationsString = fetchOperationResult.result || "{operations: []}";
  const functionDetails =
    fetchOperationResult.componentFunctionDetailsPerPoint || new Map();
  const otherFiberTypeDetails =
    fetchOperationResult.nonComponentFiberTypesPerPoint || new Map();

  // Currently defined in Chromium, in record_replay_interface.cc
  const MAX_PREVIEWABLE_PROPERTIES = 1000;

  // Mixed array of functions, strings, and numbers
  // This enables us to include entire function previews in the PauseData,
  // because they're directly in this array and runEvaluations will fill in
  // previews for the top-level items in the array.
  const chunks: ChunksArray = [];

  splitStringIntoChunks(chunks, operationsString);

  // Reserve space for the map size value
  const numChunksBeforeComponentFunctionsMap = chunks.length + 1;

  // Why are we pushing `functionDetails` to `chunks`?
  // Routine only supports `preview` of nested objects, if we return inside another object
  // or array, we can't get the preview of the nested object. Needed down in `processComponentMap`
  // Chromium in turn has a 1000-property limit on the number of properties that can be previewed.
  // To save on the number of entries in this array,
  // we also stringify the value object containing
  // {minifiedDisplayName, fiberIds}.

  const serializedFunctionDetails = serializeMapChunks(
    numChunksBeforeComponentFunctionsMap,
    functionDetails
  );

  // Add the map size value + contents
  chunks.push(serializedFunctionDetails.numAddedKeyValuePairs);
  chunks.push(...serializedFunctionDetails.mapKeyValueChunks);

  // Reserve space for the map size value
  const numChunksBeforeOtherFiberTypesMap = chunks.length + 1;

  const serializedOtherFiberTypes = serializeMapChunks(
    numChunksBeforeOtherFiberTypesMap,
    otherFiberTypeDetails
  );

  // Add the map size value + contents
  chunks.push(serializedOtherFiberTypes.numAddedKeyValuePairs);
  chunks.push(...serializedOtherFiberTypes.mapKeyValueChunks);

  return chunks;
}
