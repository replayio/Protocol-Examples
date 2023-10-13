/* Copyright 2023 Record Replay Inc. */

// React DevTools routine logic that will be evaluated in the paused browser

// Disable eslint rules to keep code closer to the original react devtools backend.
/* eslint-disable no-prototype-builtins, @typescript-eslint/ban-ts-comment */

export type UnknownFunction = (...args: unknown[]) => unknown;

// These strings will be in scope in each annotation point, so we know
// what kind of annotation we're evaluating.
// In practice we only care about commits.
export enum AnnotationType {
  Inject = "inject",
  Unmount = "commit-fiber-unmount",
  Commit = "commit-fiber-root",
  PostCommit = "post-commit-fiber-root",
}

export interface RDTComponentFunctionDetailsPerPoint {
  minifiedDisplayName?: string;
  fiberIds: number[];
}

type RDTHookCallbackResult =
  | {
      operations: number[][] | null;
      componentFunctionDetailsPerPoint?: Map<
        UnknownFunction,
        RDTComponentFunctionDetailsPerPoint
      >;
      nonComponentFiberTypesPerPoint?: Map<
        UnknownFunction,
        RDTComponentFunctionDetailsPerPoint
      >;
    }
  | { error: string };

export type FetchOperationsResult = ReturnType<typeof buildFetchReactCommitOperations>;

export type ChunksArray = (UnknownFunction | string | number)[];

export interface RDTSerializedResultContents {
  operations: number[][] | null;
  error?: string;
  stack?: string;
  messages?: string[];
  serializedTree: string;
}

export type FiberDescription = {
  id: number;
  displayName: string;
  originalDisplayName?: string;
  etype: number;
  filtered: boolean;
  key: string | null;
  children: FiberDescription[];
};

// As of 2023-07-28, we only actually care about `onCommitRoot`,
// but leaving this declaration here for completeness
interface DevtoolsHooks {
  onInject(renderer: any): RDTHookCallbackResult;
  onCommitRoot(
    rendererID: number,
    root: any,
    priorityLevel: number,
    unmountedFibersSet: Set<any>,
    unmountedFiberAlternates: Map<any, any>
  ): RDTHookCallbackResult;
}

// These variables exist in scope in the Chromium RDT stub handlers where we eval
// based on the annotation timestamps. Not all variables exist in each handler, but
// we can declare their existence here and get semi-decent type checking.
declare let renderer: Record<string, unknown>;
declare let unmountedFibersSet: Set<any>;
declare let EXTRACT_OPERATIONS_OBJ: DevtoolsHooks;
declare let rendererID: number;
declare let priorityLevel: number;
declare let root: Record<string, unknown>;
declare let unmountedFiberAlternates: Map<any, any>;

// This function is does not run in this Node process, it is stringified and sent
// to the JS runtime process to execute there.
export function prepareDevtoolsHooks(): DevtoolsHooks {
  const evaluationLogs: Array<string> = [];
  const operations: Array<Array<number>> = [];

  const DEBUG_LOG_MESSAGES = false;
  const DEBUG_SERIALIZE_TREE = false;

  // We run our react devtools scripts in a scope where these globals
  // are overridden in order to load the devtools without triggering
  // any native JS APIs that might introduce unexpected side-effects and divergence.
  const globals = (() => {
    const document = {};
    return {
      undefined: undefined,
      Proxy: undefined,
      navigator: {},
      document,
      window: {
        document,
        // Makeshift debug logging for code being evaluated in the pause.
        // Call 'window.logMessage("abc")' into the RDT bundles, and
        // then we retrieve this array at the end to see what happened.
        logMessage: (msg: string) => evaluationLogs.push(msg),
        addEventListener: (name: string) => {
          if (name !== "message") {
            throw new Error("unexpected messages listener:" + name);
          }
        },
        postMessage: ({ source }: any) => {
          if (
            source !== "react-devtools-bridge" &&
            source !== "react-devtools-detector"
          ) {
            throw new Error("unexpected postMessage:" + source);
          }
        },
      },
      setTimeout: () => {},
      clearTimeout: () => {},
      performance: undefined,
      console: {
        log: () => {},
        warn: () => {},
        error: () => {},
      },
    };
  })();
  const mockWindow: any = globals.window;

  mockWindow.logMessage("RDT environment initialized");

  function runWithGlobals(str: string) {
    // Execute the given string with each key from 'globals' introduced
    // as a binding that the expression can use. These are introduced so
    // that we can shadow the actual globals that the libraries use, to
    // avoid accessing the real globals and potentially causing divergence.
    new Function(...Object.keys(globals), str)(...Object.values(globals));
  }

  // Evaluate the actual RDT hook installation file, so that this pause
  // has the initial RDT infrastructure available
  // @ts-ignore
  runWithGlobals(INSTALL_HOOK_PLACEHOLDER_STR);

  // In actual React devtools usage, the wrapper may load much later
  // than the install hook, and thus the devtools might have
  // operations to emit right away, but since we install both at the
  // same time (after some of those things have happend), there's
  // no way for operations to be emitted.
  (mockWindow as any).__REACT_DEVTOOLS_GLOBAL_HOOK__.sub(
    "operations",
    (newOperations: Array<number>) => {
      operations.push(newOperations);
    }
  );

  // Evaluate the actual RDT backend logic file, so that the rest of the
  // RDT logic is installed in this pause.
  // @ts-ignore
  runWithGlobals(DEVTOOLS_PLACEHOLDER_STR);

  function assert(condition: boolean, msg: string) {
    if (!condition) {
      throw new Error(msg);
    }
  }

  assert(operations.length === 0, "unexpected operations before hook calls");

  let injectedRendererCount = 0;
  const assertRenderersInjected = () => {
    const renderers: Array<unknown> = (window as any).__REACT_DEVTOOLS_SAVED_RENDERERS__;

    assert(
      injectedRendererCount === renderers.length,
      "unexpected un-injected renderers"
    );
  };

  // Our stub code saved references to the React renderers that were in the page.
  // Force-inject those into the RDT backend so that they're connected properly.
  (window as any).__REACT_DEVTOOLS_SAVED_RENDERERS__.forEach((renderer: any) => {
    injectedRendererCount += 1;
    mockWindow.__REACT_DEVTOOLS_GLOBAL_HOOK__.inject(renderer);
  });

  const clearPendingOperations = () => {
    operations.length = 0;
  };

  // _Don't_ process any operations generated from the re-injection step.
  // Only deal with them when we see a commit.
  // Experimentation shows that the only times we see operations here
  // is from React <16, and we're not trying to support that.
  clearPendingOperations();

  const takeOperations = () => {
    const ops = operations.slice();
    clearPendingOperations();
    return ops;
  };

  const handleOrRethrowError = (err: unknown) => {
    if (!(err instanceof Error)) {
      throw err;
    }

    // This error is thrown from inside the reactDevToolsWrapper bundle we load.
    if (err.message.includes("Could not find ID for Fiber")) {
      return { error: "NO_FIBER_ID", stack: err.stack };
    }
    if (err.message.includes("Missing persistent ID for fiber")) {
      return { error: "MISSING_PERSISTENT_ID", stack: err.stack };
    }
    if (err.message.includes("Expected root pseudo key to be known")) {
      return { error: "UNKNOWN_ROOT_PSEUDO_KEY", stack: err.stack };
    }
    throw err;
  };

  function traverseComponentTree(fiberNode: any, callback: (fiber: any) => void) {
    callback(fiberNode);

    let child = fiberNode.child;
    while (child) {
      traverseComponentTree(child, callback);
      child = child.sibling;
    }
  }

  // These next two functions are used for local debugging only,
  // to allow printing the real component tree as a string

  // Create a lightweight serialization of the real fiber tree,
  // for display purposes
  function recordComponentTree(fiberNode: any, renderer: any) {
    const fiberDescription: FiberDescription = {
      id: renderer.getOrGenerateFiberID(fiberNode),
      displayName: renderer.getDisplayNameForFiber(fiberNode),
      etype: renderer.getElementTypeForFiber(fiberNode),
      filtered: renderer.shouldFilterFiber(fiberNode),
      key: fiberNode.key,
      children: [],
    };

    let child = fiberNode.child;
    while (child) {
      const childDescription = recordComponentTree(child, renderer);
      if (childDescription !== null) {
        fiberDescription.children.push(childDescription);
      }
      child = child.sibling;
    }

    return fiberDescription;
  }

  function printComponentDescriptionTree(
    description: FiberDescription,
    lines: string[],
    indent = 0
  ) {
    // format a component like: <ComponentName (123) key="key">, with appropriate indent
    const prefix = "".padStart(indent * 2, " ");
    const keyString = description.key !== null ? ` key="${description.key}"` : "";
    const line = `${prefix}<${description.displayName} (${description.id})${keyString} >`;

    lines.push(line);

    for (const child of description.children) {
      printComponentDescriptionTree(child, lines, indent + 1);
    }
  }

  // This returned object is exposed as EXTRACT_OPERATIONS_OBJ inside
  // the runEvaluation expression.
  return {
    onInject: renderer => {
      // There may have been some operations added before the hook was installed.
      // Clear those out - they'll be handled during the commit check
      clearPendingOperations();

      // As we're running forward to annotation points, inject any more renderers that appear.
      injectedRendererCount += 1;

      const rendererID = mockWindow.__REACT_DEVTOOLS_GLOBAL_HOOK__.inject(renderer);

      mockWindow.logMessage(
        `Renderer injected: ID ${rendererID}, version: ${renderer.version ?? "unknown"}`
      );

      return {
        operations: null,
      };
    },
    onCommitRoot: (
      rendererID,
      root,
      priorityLevel,
      unmountedFibersSet: Set<any>,
      unmountedFiberAlternates: Map<any, any>
    ) => {
      // If React <16 is in the page, it may have emitted operations.
      // We are ignoring those intentionally, since we only support 16+.
      // All 16+ operations will be generated in this `onCommitRoot` callback.
      clearPendingOperations();
      assertRenderersInjected();

      // Create a fresh map for every point,
      // so that we minimize the number of unique function references
      // that we have to serialize back to the routine
      mockWindow.componentFunctionDetailsPerPoint = new Map();
      mockWindow.nonComponentFiberTypesPerPoint = new Map();
      mockWindow.unmountedFiberAlternates = unmountedFiberAlternates;

      let stringifiedSerializedTree = "";

      try {
        const renderer = mockWindow.__REACT_DEVTOOLS_GLOBAL_HOOK__.rendererInterfaces.get(
          rendererID
        );

        for (const fiber of unmountedFibersSet) {
          // We need to ensure that all these fibers have IDs in memory inside of RDT,
          // otherwise `recordUnmount()` will bail out and not try to remove them
          if (fiber.alternate) {
            renderer.getOrGenerateFiberID(fiber.alternate);
          }
          renderer.getOrGenerateFiberID(fiber);

          // There may have been unmounted fibers for this commit,
          // collected from the separate `unmount` calls.
          // Force the RDT backend logic to process each of those.
          // This will include those as the first ops in the operations array we return here.
          mockWindow.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberUnmount(
            rendererID,
            fiber
          );
        }

        if (DEBUG_SERIALIZE_TREE && root.current.child) {
          // Local debugging: print the component tree to a string,
          // so it can be diffed vs what the RDT operations store thinks the tree is
          const fiberDescriptions = recordComponentTree(root.current, renderer);
          if (fiberDescriptions) {
            const lines = [`[root (${renderer.getOrGenerateFiberID(root.current)})]`];
            printComponentDescriptionTree(fiberDescriptions, lines, 1);

            stringifiedSerializedTree = JSON.stringify(fiberDescriptions);
          }
        }

        const rootID = renderer.getOrGenerateFiberID(root.current);
        renderer.setRootPseudoKey(rootID, root.current);
        traverseComponentTree(root.current, fiber => {
          renderer.getOrGenerateFiberID(fiber);
        });

        mockWindow.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(
          rendererID,
          root,
          priorityLevel
        );
      } catch (err) {
        return handleOrRethrowError(err);
      }

      return {
        operations: takeOperations(),
        serializedTree: DEBUG_SERIALIZE_TREE ? stringifiedSerializedTree : undefined,
        messages: DEBUG_LOG_MESSAGES
          ? evaluationLogs.splice(0, evaluationLogs.length)
          : undefined,
        componentFunctionDetailsPerPoint: mockWindow.componentFunctionDetailsPerPoint,
        nonComponentFiberTypesPerPoint: mockWindow.nonComponentFiberTypesPerPoint,
      };
    },
  };
}

// This function is does not run in this Node process, sent
// to the JS runtime process to execute there.
export function buildFetchReactCommitOperations() {
  // Pull in the hooks that were created by the preload expression.
  const { onInject, onCommitRoot }: DevtoolsHooks = EXTRACT_OPERATIONS_OBJ;

  let result: RDTHookCallbackResult;
  // Process the annotation type and call the appropriate extraction logic
  // that we injected at the start of the recording.

  // This variable is in scope in `onInject`, but not `onCommitFiberRoot`
  const isInjectCallback = typeof renderer !== "undefined";

  // We currently only fetch annotations for `inject` and `onCommitFiberRoot` callbacks,
  // so those should be the only two cases we need to handle here.
  if (isInjectCallback) {
    result = onInject(renderer);
  } else {
    // Handle earlier recordings that did not have this in scope
    const actualUnmountedFiberAlternates =
      typeof unmountedFiberAlternates === "undefined"
        ? new Map()
        : unmountedFiberAlternates;

    result = onCommitRoot(
      rendererID,
      root,
      priorityLevel,
      unmountedFibersSet,
      actualUnmountedFiberAlternates
    );
  }

  if ("error" in result) {
    // We do want to return the error value as a field
    // named "result" here.
    // Too many levels of nesting :)
    return { result: JSON.stringify(result) };
  }

  const {
    componentFunctionDetailsPerPoint,
    nonComponentFiberTypesPerPoint,
    ...restOfResult
  } = result;

  return {
    // Stringify the result so that it can be passed back to this process without
    // needing individually piece together the parts of the result.
    result: JSON.stringify(restOfResult),
    componentFunctionDetailsPerPoint,
    nonComponentFiberTypesPerPoint,
  };
}
