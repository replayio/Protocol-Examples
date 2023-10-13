/* Copyright 2023 Record Replay Inc. */

// Routine to process dispatched Redux actions in a recording and perform initial analysis

import { Annotation, ExecutionPoint } from "@replayio/protocol";
import groupBy from "lodash/groupBy";
import { assert } from "../../../shared/assert";
import { Context } from "../../../shared/context";
import { Routine, RoutineError, RoutineSpec } from "../routine";
import { buildDateStringToDate } from "../../../shared/linkerVersion";
import { compareExecutionPoints } from "../shared/time";
import { Errors, isProtocolError } from "../../../protocol/errors";

// types borrowed from the Redux DevTools source

interface LocalFilter {
  allowlist: string | undefined;
  denylist: string | undefined;
}

interface Action<T = any> {
  type: T;
}

interface AnyAction extends Action {
  // Allows any extra properties to be defined in an action.
  [extraProps: string]: any;
}

interface Config {
  readonly stateSanitizer?: <S>(state: S, index?: number) => S;
  readonly actionSanitizer?: <A extends Action<unknown>>(action: A, id?: number) => A;
  readonly predicate?: <S, A extends Action<unknown>>(state: S, action: A) => boolean;
}

type ExtractedExtensionConfig = Pick<
  Config,
  "stateSanitizer" | "actionSanitizer" | "predicate"
> & {
  instanceId: number;
  isFiltered: <A extends Action<unknown>>(
    action: A | string,
    localFilter: LocalFilter | undefined
  ) => boolean | "" | RegExpMatchArray | null | undefined;
  localFilter: LocalFilter | undefined;
};

interface LastSavedValues {
  action: string | AnyAction;
  state: any;
  extractedConfig: ExtractedExtensionConfig;
  config: Config;
}

declare global {
  interface Window {
    evaluationLogs: string[];
    logMessage: (message: string) => void;
  }
}
// These types aren't actually attached to `window`, but _should_ be in
// scope when we evaluate code at the original annotation timestamps.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare let latestDispatchedActions: Record<string, LastSavedValues>;

declare let action: AnyAction;
declare let state: any;
declare let extractedConfig: ExtractedExtensionConfig;

// EVALUATED REMOTE FUNCTIONS:

function checkIfActionIsFiltered() {
  const { isFiltered, localFilter, predicate } = extractedConfig;
  const excludedByFilter = !!isFiltered(action, localFilter);
  const excludedByPredicate = predicate && !predicate(state, action);

  const shouldIgnoreAction = excludedByFilter || !!excludedByPredicate;
  return JSON.stringify({ actionType: action.type, shouldIgnoreAction });
}

interface ParsedReduxActionEntry {
  type: "init" | "action";
  actionType: string;
  connectionType: "redux" | "generic";
  instanceId: number;
}

interface ProcessedActionInfo {
  point: ExecutionPoint;
  time: number;
  actionType: string;
  shouldIgnoreAction: boolean;
  connectionType: "redux" | "generic";
  instanceId: number;
}

// Napkin math: 10 actions/sec for 3 minutes = 1800, + 200 wiggle room
const MAX_POINTS_TO_EVALUATE = 2000;

async function runReduxDevtoolsRoutine(routine: Routine, cx: Context) {
  const annotations = await routine.getAnnotations("redux-devtools-setup", cx);

  const parsedAnnotations = annotations.map(annotation => {
    const parsedContents = JSON.parse(annotation.contents);
    return {
      ...annotation,
      contents: JSON.parse(parsedContents.message) as ParsedReduxActionEntry,
    };
  });

  const annotationsToEvaluate = parsedAnnotations.filter(
    a => a.contents.type === "action"
  );

  if (annotationsToEvaluate.length > MAX_POINTS_TO_EVALUATE) {
    // Throw an actual error to kill the routine and make it visible
    // how often we're hitting recordings that are over this limit
    throw new RoutineError("TOO_MANY_ACTIONS", {
      actionCount: annotationsToEvaluate.length,
    });
  }

  cx.logger.debug("ReduxDevtoolsEvaluationPoints", {
    count: annotationsToEvaluate.length,
  });

  const annotationByPoint = groupBy(
    annotationsToEvaluate,
    annotation => annotation.point
  );

  const allPointResults: ProcessedActionInfo[] = [];
  await routine.runEvaluation(
    {
      points: annotationsToEvaluate.map(annotation => annotation.point),
      expression: `(${checkIfActionIsFiltered})()`,
      // Run in top frame.
      frameIndex: 0,
      // Can't use `shareProcesses` here, because we're calling userland code
      // in the evaluations to determine if actions should be filtered out,
      // and it's not safe to run userland code in shared processes.
      onResult: ({ point, failed, returned, exception, data }) => {
        if (failed) {
          cx.logger.debug("ReduxEvalFailed", {
            returned,
            exception,
            data,
          });
          throw new RoutineError("REDUX_EVAL_FAILED", {
            point: point.point,
          });
        }
        if (!returned) {
          cx.logger.debug("ReduxEvalException", {
            exception,
            data,
          });
          throw new RoutineError("REDUX_EVAL_EXCEPTION", {
            point: point.point,
          });
        }
        assert(
          typeof returned.value === "string",
          "Routine eval did not return a string"
        );

        const { actionType, shouldIgnoreAction } = JSON.parse(returned.value);
        const { connectionType, instanceId } = annotationByPoint[point.point][0].contents;

        allPointResults.push({
          point: point.point,
          time: point.time,
          actionType,
          shouldIgnoreAction,
          connectionType,
          instanceId,
        });
      },
    },
    cx
  );

  allPointResults.sort((a, b) => compareExecutionPoints(a.point, b.point));

  for (const result of allPointResults) {
    const { point, time, ...payload } = result;

    const annotation: Annotation = {
      point,
      time,
      kind: "redux-devtools-data",
      contents: JSON.stringify({
        event: "action",
        payload,
      }),
    };

    routine.addAnnotation(annotation);
  }
}

export const ReduxDevtoolsRoutine: RoutineSpec = {
  name: "ReduxDevtools",
  version: 2,
  annotationKinds: ["redux-devtools-data"],
  runRoutine: async (routine, cx) => {
    try {
      await runReduxDevtoolsRoutine(routine, cx);
    } catch (err) {
      // See BAC-3767.
      if (isProtocolError(err, Errors.CommandFailed)) {
        throw new RoutineError("COMMAND_FAILED");
      }
      if (isProtocolError(err, Errors.TimedOut)) {
        throw new RoutineError("COMMAND_TIMED_OUT");
      }

      throw err;
    }
  },
  shouldRun: ({ runtime, date: dateString }) => {
    const date = buildDateStringToDate(dateString);
    // Should have the Redux DevTools stub after at least this date.
    const requiredMinBuildDate = new Date("2023-05-10");

    const validRuntime = runtime == "chromium";
    const recordingIsAfterMinBuildDate = date >= requiredMinBuildDate;
    return validRuntime && recordingIsAfterMinBuildDate;
  },
};
