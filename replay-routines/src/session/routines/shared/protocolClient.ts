/* Copyright 2023 Record Replay Inc. */

import { ProtocolClient } from "@replayio/protocol";

import { Context } from "../../../shared/context";
import { RoutineInterface } from "../routine";

export function createProtocolClient(iface: RoutineInterface, cx: Context) {
  const protocolClient = new ProtocolClient({
    sendCommand(method, params, sessionId, pauseId) {
      return iface.sendCommand(method, params, pauseId, cx);
    },

    addEventListener(event, listener) {
      iface.addEventListener(event, listener);
    },
    removeEventListener(event, listener) {
      if (listener) {
        iface.removeEventListener(event, listener);
      }
    },
  });

  return protocolClient;
}
