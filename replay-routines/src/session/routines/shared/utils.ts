/* Copyright 2023 Record Replay Inc. */

import { Object as ProtocolObject } from "@replayio/protocol";
import util from "util";

export function logTimestamp(...args: any[]) {
  console.log(new Date(), ...args);
}

export function inspectDeep(value: any, depth = 10) {
  return util.inspect(value, {
    depth,
    colors: true,
    maxArrayLength: null,
    maxStringLength: Infinity,
    breakLength: 120,
  });
}

export function getPropertyByName(object: ProtocolObject, name: string) {
  return object.preview?.properties?.find(prop => prop.name === name);
}

type ErrorHandler = (error: Error) => void;

export const errorHandler: ErrorHandler = (error: Error) => {
  throw error;
};

export function assert(condition: any, message = "Assertion failed!"): asserts condition {
  if (!condition) {
    console.error(message);
    errorHandler(new Error(message));
  }
}

export const waitForTime = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

export function throttle(callback: () => void, time: number) {
  let scheduled = false;
  return () => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      callback();
    }, time);
  };
}

export function clamp(value: number, min: number, max: number) {
  assert(min < max, "min should be less than max");
  return Math.max(min, Math.min(max, value));
}

export function binarySearch(
  start: number,
  end: number,
  callback: (mid: number) => number
) {
  while (start + 1 < end) {
    const mid = ((start + end) / 2) | 0;
    const rv = callback(mid);
    if (rv < 0) {
      end = mid;
    } else {
      start = mid;
    }
  }
  return start;
}

export interface CommandError extends Error {
  name: "CommandError";
  code: number;
}

export enum ProtocolError {
  InternalError = 1,
  UnsupportedRecording = 31,
  UnknownBuild = 32,
  CommandFailed = 33,
  RecordingUnloaded = 38,
  DocumentIsUnavailable = 45,
  TimedOut = 46,
  LinkerDoesNotSupportAction = 48,
  InvalidRecording = 50,
  ServiceUnavailable = 51,
  TooManyPoints = 55,
  UnknownSession = 59,
  GraphicsUnavailableAtPoint = 65,
  SessionDestroyed = 66,
  TooManyLocationsToPerformAnalysis = 67,
  SessionCreationFailure = 72,
}

export const commandError = (message: string, code: number): CommandError => {
  const err = new Error(message) as CommandError;
  err.name = "CommandError";
  err.code = code;
  return err;
};

export const isCommandError = (error: unknown, code: number): boolean => {
  if (error instanceof Error) {
    return error.name === "CommandError" && (error as CommandError).code === code;
  } else if (typeof error === "string") {
    console.error("Unexpected error type encountered (string):\n", error);

    switch (code) {
      case ProtocolError.TooManyPoints:
        // TODO [BAC-2330] The Analysis endpoint returns an error string instead of an error object.
        // TODO [FE-938] The error string may contain information about the analysis; it may not be an exact match.
        return error.startsWith("There are too many points to complete this operation");
      case ProtocolError.LinkerDoesNotSupportAction:
        return (
          error ===
          "The linker version used to make this recording does not support this action"
        );
    }
  }

  return false;
};
