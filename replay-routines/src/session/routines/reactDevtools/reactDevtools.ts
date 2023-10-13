/* Copyright 2023 Record Replay Inc. */

// Routine to run the react devtools backend in a recording and generate its operations arrays.

// Disable eslint rules to keep code closer to the original react devtools backend.
/* eslint-disable no-prototype-builtins, @typescript-eslint/ban-ts-comment */
import { Annotation, NavigationEvent as ReplayNavigationEvent } from "@replayio/protocol";
import fs from "fs";

import { Context } from "../../../shared/context";
import { buildDateStringToDate } from "../../../shared/linkerVersion";
import { Errors, isProtocolError } from "../../../protocol/errors";
import { silenceUnhandledRejection } from "../../../shared/promise";

// These are plain JS files that are being imported at build time,
// so that we can stringify the JS functions and send them to be
// evaluated at runtime. We don't currently have a good way to
// include these files as assets in a backend deployment otherwise.
// @ts-ignore
import { reactDevToolsWrapper } from "./assets/react_devtools_backend";
// @ts-ignore
import { installHookWrapper } from "./assets/installHook";

import { Routine, RoutineError, RoutineSpec } from "../routine";
import { createProtocolClient } from "../shared/protocolClient";
import { ReplayClient } from "../shared/replayClient";
import { createCaches } from "../shared/caches/ProtocolDataCaches";
import { SourcesById } from "../shared/sources";
import {
  ParsedReactDevtoolsTreeOperations,
  createRDTCaches,
  deriveOriginalComponentDisplayNames,
  didReactDOMExecute,
  filterDuplicateNodeRemovalOperations,
  insertRootRemovalOpsForNavEvents,
  printComponentDescriptionTree,
  reconstructOperationsArray,
  rewriteOperationsStringTable,
} from "./rdtProcessing";
import {
  AnnotationType,
  FiberDescription,
  buildFetchReactCommitOperations,
  prepareDevtoolsHooks,
} from "./rdtEvaluations";
import {
  ProcessedRDTResults,
  RDTEvaluationResult,
  processRDTEvaluationResults,
  serializeFetchOperationsResult,
} from "./rdtEvaluationSerialization";
import { compareExecutionPoints } from "../shared/time";
import { Store, printStore } from "./rdtStore";
import { inspectDeep } from "../shared/utils";
import { printOperationsArray } from "./printOperations";
import { Tags } from "../../../shared/logger";

const DEBUG_WRITE_TREES_TO_DISK = false;
const DEBUG_PRINT_OPERATIONS_DESCRIPTIONS = false;
const DEBUG_LOG_OPERATIONS_FAILURES = false;

const RDT_ANNOTATION_V1_PREFIX = "react-devtools-hook:v1:";

export const RDT_ANNOTATION_INJECT = `${RDT_ANNOTATION_V1_PREFIX}${AnnotationType.Inject}` as const;
export const RDT_ANNOTATION_COMMIT = `${RDT_ANNOTATION_V1_PREFIX}${AnnotationType.Commit}` as const;

async function runReactDevtoolsRoutine(routine: Routine, cx: Context) {
  const protocolClient = createProtocolClient(routine.iface, cx);
  const replayClient = new ReplayClient(protocolClient);
  const cachesCollection = createCaches();
  const rdtCaches = createRDTCaches(cachesCollection);

  const navigationEvents: ReplayNavigationEvent[] = [];

  protocolClient.Session.addNavigationEventsListener(entry => {
    navigationEvents.push(...entry.events);
  });

  const navEventsPromise = protocolClient.Session.findNavigationEvents({});

  // Start fetching sources right away, but don't block on it
  const sourcesByIdPromise = cachesCollection.sourcesByIdCache.readAsync(replayClient);
  // `readAsync` can technically return a non-promise, but definitely a promise here
  silenceUnhandledRejection(sourcesByIdPromise as Promise<SourcesById>);
  silenceUnhandledRejection(navEventsPromise);

  const annotationsToEvaluate = (
    await Promise.all([
      routine.getAnnotations(RDT_ANNOTATION_INJECT, cx),
      routine.getAnnotations(RDT_ANNOTATION_COMMIT, cx),
    ])
  ).flat();

  annotationsToEvaluate.sort((a, b) => compareExecutionPoints(a.point, b.point));

  cx.logger.debug("ReactDevtoolsEvaluationPoints", {
    count: annotationsToEvaluate.length,
  });

  const evalResults: RDTEvaluationResult[] = [];

  let sourcesById: SourcesById;
  let processedEvalResults: ProcessedRDTResults;

  try {
    await routine.runEvaluation(
      {
        points: annotationsToEvaluate.map(annotation => annotation.point),
        shareProcesses: true,
        fullReturnedPropertyPreview: true,
        preloadExpressions: [
          {
            name: "EXTRACT_OPERATIONS_OBJ",
            // Generate the entire evaluated JS expression, by:
            // - Setting up the initial environment with our globals
            // - Injecting the RDT "global hook" setup bundle
            // - Injecting the RDT "backend" bundle
            expression: `(${prepareDevtoolsHooks})()`
              .replace(
                "INSTALL_HOOK_PLACEHOLDER_STR",
                JSON.stringify(`(${installHookWrapper})()`)
              )
              .replace(
                "DEVTOOLS_PLACEHOLDER_STR",
                JSON.stringify(`(${reactDevToolsWrapper})()`)
              ),
          },
        ],
        // Actually run the RDT bundle, generate the operations array +
        // component name + fibers data, and serialize it back as a giant
        // mixed array of strings, numbers, and function references.
        expression: `
          try {
            const fetchOperationResult = (${buildFetchReactCommitOperations})();

            const chunks = (${serializeFetchOperationsResult})(fetchOperationResult);

            // Implicit return via statement
            chunks;
          } catch (err) {
            err?.stack;
          }
        `,
        frameIndex: 0,
        onResult: ({ point, failed, returned, exception, data }) => {
          if (failed) {
            cx.logger.debug("ReactEvalFailed", {
              returned,
              exception,
              data,
            });
            throw new RoutineError("REACT_EVAL_FAILED", {
              point: point.point,
            });
          }
          if (!returned) {
            cx.logger.debug("ReactEvalException", {
              exception,
              data,
            });
            throw new RoutineError("REACT_EVAL_EXCEPTION", {
              point: point.point,
            });
          }

          evalResults.push({
            point: point.point,
            time: point.time,
            value: returned,
            data,
          });
        },
      },
      cx
    );

    // Make sure we have sources before we process the results
    sourcesById = await sourcesByIdPromise;

    // Deserialize the values from the evaluations
    processedEvalResults = await processRDTEvaluationResults(
      evalResults,
      sourcesById,
      cx
    );

    // Now that we have a full list of all the component functions we've seen
    // through the entire recording, we can process them to figure out the right
    // original display names for each one.
    // This does the processing in parallel, but requires looking up source outlines,
    // which can block for a few seconds.
    await deriveOriginalComponentDisplayNames(
      sourcesById,
      replayClient,
      processedEvalResults.functionReferencesByLocation,
      rdtCaches,
      processedEvalResults.functionDetailsByLocation
    );
  } catch (err) {
    if (isProtocolError(err, Errors.CommandFailed)) {
      // The command could legitimately fail if it fails to perform the
      // evaluation after too many retries.
      throw new RoutineError("EVAL_COMMAND_FAILED");
    }

    throw err;
  }

  const {
    allOperations,
    allFiberIdsToFunctionReferences,
    functionDetailsByLocation,
    fiberIdsToBuiltinComponentNames,
  } = processedEvalResults;

  allOperations.sort((a, b) => compareExecutionPoints(a.point, b.point));

  await navEventsPromise;

  const operationsWithPageNavResets = insertRootRemovalOpsForNavEvents(
    allOperations,
    navigationEvents
  );

  const operationsWithDuplicateNodeOpsRemoved = filterDuplicateNodeRemovalOperations(
    operationsWithPageNavResets
  );

  // Ignore operations which don't include any changes.
  const meaningfulOperations = operationsWithDuplicateNodeOpsRemoved.filter(
    o => o.deconstructedOperations.treeOperations.length > 0
  );

  if (meaningfulOperations.length === 0) {
    // This will probably happen a lot, since non-React recordings
    // certainly won't have any React operations.
    // BUT, if React ran at all,then this is actually an error, since
    // we should have seen _some_ operations.
    // Check to see if React loaded.
    const didReactRun = await didReactDOMExecute(
      replayClient,
      cachesCollection,
      sourcesById
    );

    if (didReactRun) {
      throw new RoutineError("UNEXPECTED_EMPTY_REACT_OPERATIONS");
    } else {
      return;
    }
  }

  const {
    operationsWithRewrittenComponentNames,
    fiberIdsToComponentNames,
  } = rewriteOperationsStringTable(
    meaningfulOperations,
    sourcesById,
    allFiberIdsToFunctionReferences,
    functionDetailsByLocation,
    fiberIdsToBuiltinComponentNames
  );

  const finalAnnotations: Annotation[] = [];

  // A cut-down version of the RDT UI's Store class, which we can use
  // to verify that all operations are valid.
  const store = new Store();

  if (DEBUG_WRITE_TREES_TO_DISK) {
    // Local debug: write out the trees to disk, so we can compare them

    if (fs.existsSync("actualFiberTree.txt")) {
      fs.unlinkSync("actualFiberTree.txt");
    }

    if (fs.existsSync("calculatedTree.txt")) {
      fs.unlinkSync("calculatedTree.txt");
    }

    // Make sure these all get written out regardless of any errors
    const allFiberDescriptions: {
      point: string;
      time: number;
      fiberDescriptions: FiberDescription;
    }[] = [];

    for (const {
      point,
      time,
      fiberDescriptions,
    } of operationsWithRewrittenComponentNames) {
      if (fiberDescriptions) {
        allFiberDescriptions.push({ point, time, fiberDescriptions });
        const lines: string[] = [];
        printComponentDescriptionTree(
          fiberDescriptions,
          lines,
          true,
          false,
          fiberIdsToComponentNames
        );

        const treeString = lines.join("\n");

        fs.appendFileSync(
          "actualFiberTree.txt",
          ["\n", JSON.stringify({ point, time }), "\n", treeString].join("")
        );
      }
    }

    if (allFiberDescriptions.length) {
      fs.writeFileSync(
        "fiberDescriptions.json",
        JSON.stringify(allFiberDescriptions, null, 2)
      );
    }
  }

  const successfulOperations: number[][] = [];

  for (const entry of operationsWithRewrittenComponentNames) {
    const { point, time, deconstructedOperations } = entry;
    // Create the new numerical operations array based on our rewritten parsed operations
    const operations = reconstructOperationsArray(deconstructedOperations);

    const annotation: Annotation = {
      point,
      time,
      kind: "react-devtools-bridge",
      contents: JSON.stringify({ event: "operations", payload: operations }),
    };

    if (DEBUG_PRINT_OPERATIONS_DESCRIPTIONS) {
      // Local debug: print a readable description of the tree operations
      console.log(inspectDeep({ point, time }), printOperationsArray(operations));
    }

    try {
      // Ensure that the RDT UI will process these operations correctly.
      // If this errors, re-throw the error and kill the routine, so that we don't persist anything.
      store.onBridgeOperations(operations);
    } catch (err: any) {
      // Something went wrong.
      // Time to try figuring out what things looked like, so
      // we can log a more meaningful comparison
      const backupStore = new Store();
      for (const ops of successfulOperations) {
        backupStore.onBridgeOperations(ops);
      }

      const { rendererId, rootId, stringTable, treeOperations } = deconstructedOperations;

      // Now, break down the current point's tree ops into individual
      // operations arrays, and figure out what the store looked like
      let printedTree = printStore(backupStore);
      let lastSuccessfulTreeOp: ParsedReactDevtoolsTreeOperations | undefined;
      let failedTreeOp: ParsedReactDevtoolsTreeOperations | undefined;
      try {
        for (const op of treeOperations) {
          const opArray = reconstructOperationsArray({
            rendererId,
            rootId,
            stringTable,
            treeOperations: [op],
          });
          failedTreeOp = op;
          backupStore.onBridgeOperations(opArray);
          lastSuccessfulTreeOp = op;
          printedTree = printStore(backupStore);
        }
      } finally {
        if (DEBUG_LOG_OPERATIONS_FAILURES) {
          console.log(
            "Failure details: ",
            inspectDeep({
              lastSuccessfulTreeOp,
              failedTreeOp,
            }),
            "\nTree: \n",
            printedTree
          );
        }
      }

      const tags: Tags = {
        message: err.message,
        operations,
        lastSuccessfulTreeOp,
        failedTreeOp,
        printedTree,
      };

      cx.logger.error("INVALID_REACT_OPERATIONS", tags);
      throw new RoutineError(`INVALID_REACT_OPERATIONS`, tags);
    }

    successfulOperations.push(operations);

    if (DEBUG_WRITE_TREES_TO_DISK) {
      fs.appendFileSync(
        "calculatedTree.txt",
        ["\n", JSON.stringify({ point, time }), "\n", printStore(store)].join("")
      );
    }

    finalAnnotations.push(annotation);

    cx.logger.debug("ReactDevtoolsOperations", {
      point,
      time,
      operationCount: operations.length,
      operations,
    });
  }

  // Do this after, so that we don't save any annotations unless they all succeeded
  for (const annotation of finalAnnotations) {
    routine.addAnnotation(annotation);
  }

  cx.logger.debug("ReactDevtoolsResultCount", { count: allOperations.length });
}

export const ReactDevtoolsRoutine: RoutineSpec = {
  name: "ReactDevtools",
  version: 9,
  annotationKinds: ["react-devtools-bridge"],
  runRoutine: runReactDevtoolsRoutine,
  shouldRun: ({ runtime, date: dateString }) => {
    const date = buildDateStringToDate(dateString);
    // Shared processes require builds after this date
    const requiredMinBuildDate = new Date("2023-05-10");

    const validRuntime = runtime == "chromium";
    const recordingIsAfterMinBuildDate = date >= requiredMinBuildDate;
    return validRuntime && recordingIsAfterMinBuildDate;
  },
};
