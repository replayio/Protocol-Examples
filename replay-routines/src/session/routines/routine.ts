/* Copyright 2023 Record Replay Inc. */

// Defines the Routine used to run recording routines. Routines can run automatically
// on backend sessions for newly created or existing recordings and perform processing
// tasks. They can also run manually from the command line using the run-routine script
// for development and other testing.
//
// For now all routines are part of the backend, but we expect to open source these and
// move the routines and related logic into a public repository.
import {
  Annotation,
  CommandMethods,
  CommandParams,
  CommandResult,
  ExecutionPoint,
  EventMethods,
  EventParams,
  runEvaluationResults,
  RunEvaluationPreload,
  RunEvaluationResult,
} from "@replayio/protocol";
import { assert } from "../../shared/assert";
import { Context } from "../../shared/context";
import { BuildComponents } from "../../shared/utils";
import { uuid } from "../../shared/uuid/v4";
import { pointStringCompare } from "../../shared/point";
import { createRejectableAbortScope } from "../../shared/abort";
import { silenceUnhandledRejection } from "../../shared/promise";
import { Tags } from "../../shared/logger";

// Low level interface needed for implementing the operations in a Routine.
export interface RoutineInterface {
  annotationKinds: Array<string>;
  sendCommand<M extends CommandMethods>(
    method: M,
    params: CommandParams<M>,
    pauseId: string | undefined,
    cx: Context
  ): Promise<CommandResult<M>>;
  addEventListener<M extends EventMethods>(
    method: M,
    handler: (params: EventParams<M>) => void
  ): void;
  removeEventListener<M extends EventMethods>(
    method: M,
    handler: (params: EventParams<M>) => void
  ): void;
  getAnnotations(kind: string, cx: Context): Promise<Annotation[]>;
  addAnnotation(annotation: Annotation): Promise<void>;
}

export type RoutineEvaluationOptions = {
  points: Array<ExecutionPoint>;
  expression: string;
  frameIndex?: number;
  fullReturnedPropertyPreview?: boolean;
  onResult: (result: RunEvaluationResult, cx: Context) => Promise<void> | void;
  preloadExpressions?: Array<RunEvaluationPreload>;
  shareProcesses?: boolean;
};

// An error subclass that routines may throw to indicate an expected error
// condition, which will indicate that this routine failed and any
// annotations should be ignored.
export class RoutineError extends Error {
  name = "RoutineError";
  tags: Tags;

  constructor(message: string, tags: Tags = {}) {
    super(message);
    this.tags = tags;
  }
}

export class Routine {
  constructor(iface: RoutineInterface) {
    this.iface = iface;
    this.annotationKinds = new Set(iface.annotationKinds);
  }

  async runEvaluation(opts: RoutineEvaluationOptions, outerCx: Context): Promise<void> {
    const onResults = async (results: Array<RunEvaluationResult>, resultsCx: Context) => {
      for (const result of results) {
        const resultPromise = opts.onResult(
          result,
          resultsCx.withLogger(
            resultsCx.logger.plainChild({
              point: result.point.point,
              pauseId: result.pauseId,
            })
          )
        );
        if (resultPromise) {
          await resultPromise;
        }
      }
    };

    await createRejectableAbortScope(async (signal, reject) => {
      const cx = outerCx.withSignal(signal);
      const runEvaluationId = uuid();

      const promises: Array<Promise<void>> = [];
      let resultCount = 0;
      const onResultEvent = (result: runEvaluationResults) => {
        if (result.runEvaluationId !== runEvaluationId) {
          return;
        }
        resultCount += result.results.length;
        const promise = onResults(result.results, cx).catch(err => {
          reject(err);
          throw err;
        });
        silenceUnhandledRejection(promise);
        promises.push(promise);
      };

      const points = opts.points.slice();
      points.sort((a, b) => pointStringCompare(a, b));
      assert(points.length === new Set(points).size, "unexpected duplicate points");

      try {
        this.iface.addEventListener("Session.runEvaluationResults", onResultEvent);

        let pointStart = 0;
        while (pointStart < points.length) {
          const maxCount = 10_000;
          // We want to avoid sending more points than will be processed because even though
          // the points after the maxCount wouldn't be evaluated, the backend would still have
          // to waste time validating them for no reason.
          const pagePoints = points.slice(pointStart, pointStart + maxCount);

          const countBeforePage = resultCount;
          const { nextBegin } = await this.iface.sendCommand(
            "Session.runEvaluation",
            {
              runEvaluationId,
              pointSelector: {
                kind: "points",
                points: pagePoints,
              },
              pointLimits: { maxCount },
              expression: opts.expression,
              frameIndex: opts.frameIndex,
              fullReturnedPropertyPreview: opts.fullReturnedPropertyPreview,
              preloadExpressions: opts.preloadExpressions,
              shareProcesses: opts.shareProcesses,
            },
            undefined,
            cx
          );
          assert(!nextBegin, "unexpected partial page evaluation", {
            nextBegin,
            countBeforePage,
            resultCount,
          });

          // Since we're giving exactly matching numbers of points and maxCount,
          // there should never be a case where runEvaluation failes to produce
          // exactly that many results, or indicates that there is a nextBegin.
          const pageCount = resultCount - countBeforePage;
          assert(pageCount === pagePoints.length, "unexpected result count mismatch", {
            pageCount,
            countBeforePage,
            resultCount,
          });

          pointStart += pageCount;
        }

        await Promise.all(promises);
      } finally {
        this.iface.removeEventListener("Session.runEvaluationResults", onResultEvent);
      }
    }, outerCx.signal);
  }

  getAnnotations(kind: string, cx: Context): Promise<Annotation[]> {
    return this.iface.getAnnotations(kind, cx);
  }

  addAnnotation(annotation: Annotation): Promise<void> {
    assert(
      this.annotationKinds.has(annotation.kind),
      "unexpected annotation kind not in allowlist",
      {
        kind: annotation.kind,
      }
    );
    return this.iface.addAnnotation(annotation);
  }

  // This should not be used outside this file, but is public for use by related
  // classes like RoutinePause.
  iface: RoutineInterface;

  private annotationKinds: Set<string>;
}

export type RoutineCallback = (routine: Routine, cx: Context) => Promise<void>;

// Specifier for a routine which can run on a recording.
export interface RoutineSpec {
  // Must be unique across all routines.
  name: string;

  // Updated whenever the routine logic changes and the routine should be re-run on
  // recordings it applies to.
  version: number;

  // A list of annotation kinds that this routine may produce.
  annotationKinds: Array<string>;

  // Callback for running the routine.
  runRoutine: RoutineCallback;

  // Callback for testing whether the routine should run on a recording.
  shouldRun: (buildInfo: BuildComponents) => boolean;
}
