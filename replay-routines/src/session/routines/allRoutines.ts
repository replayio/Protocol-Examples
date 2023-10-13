/* Copyright 2023 Record Replay Inc. */

// Defines the available routines which can run on a recording.

import { RoutineSpec } from "./routine";
import { ReactDevtoolsRoutine } from "./reactDevtools/reactDevtools";
import { ReduxDevtoolsRoutine } from "./reduxDevtools/reduxDevtools";
import { ReactEventListenersRoutine } from "./reactEventListeners/reactEventListeners";

export const AllRoutines: RoutineSpec[] = [
  ReactDevtoolsRoutine,
  ReduxDevtoolsRoutine,
  ReactEventListenersRoutine,
];
