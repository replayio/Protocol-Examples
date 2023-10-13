/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The React DevTools frontend UI data store, which reads operations arrays
// and keeps track of the current state of the React component tree.
// We use it in Replay to safety-check parsed operations data in the RDT routine,
// to ensure that the operations data is valid and can be parsed by the RDT frontend.

// This file contains code that was copied from files under:
// https://github.com/facebook/react/tree/546fe4681c52de6a333a55cedb141c87b626425e/packages/react-devtools-shared/src
// It was then converted from Flow to TS, and irrelevant code has been removed.

import { inspect } from "util";
import {
  PROFILING_FLAG_BASIC_SUPPORT,
  PROFILING_FLAG_TIMELINE_SUPPORT,
  TREE_OPERATION_ADD,
  TREE_OPERATION_REMOVE,
  TREE_OPERATION_REMOVE_ROOT,
  TREE_OPERATION_REORDER_CHILDREN,
  TREE_OPERATION_SET_SUBTREE_MODE,
  TREE_OPERATION_UPDATE_ERRORS_OR_WARNINGS,
  TREE_OPERATION_UPDATE_TREE_BASE_DURATION,
  ElementTypeRoot,
  utfDecodeString,
} from "./printOperations";

const StrictMode = 1;

// Different types of elements displayed in the Elements tree.
// These types may be used to visually distinguish types,
// or to enable/disable certain functionality.
type ElementType = 1 | 2 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

class UnsupportedBridgeOperationError extends Error {
  constructor(message: string) {
    super(message);

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, UnsupportedBridgeOperationError);
    }

    this.name = "UnsupportedBridgeOperationError";
  }
}

function printElement(element: Element, includeWeight: boolean = false): string {
  let key = "";
  if (element.key !== null) {
    key = ` key="${element.key}"`;
  }

  let hocDisplayNames = null;
  if (element.hocDisplayNames !== null) {
    hocDisplayNames = [...element.hocDisplayNames];
  }

  const hocs = hocDisplayNames === null ? "" : ` [${hocDisplayNames.join("][")}]`;

  let suffix = "";
  if (includeWeight) {
    suffix = ` (${element.isCollapsed ? 1 : element.weight})`;
  }

  const indent = "".padStart((element.depth + 1) * 2, " ");

  return `${indent}<${element.displayName || "null"} (${
    element.id
  }) ${key}>${hocs}${suffix}`;
}

export function printStore(
  store: Store,
  includeWeight: boolean = false,
  state: StateContext | null = null
): string {
  const snapshotLines = [];

  let rootWeight = 0;

  function printSelectedMarker(index: number): string {
    if (state === null) {
      return "";
    }
    return state.selectedElementIndex === index ? `→` : " ";
  }

  function printErrorsAndWarnings(element: Element): string {
    const { errorCount, warningCount } = store.getErrorAndWarningCountForElementID(
      element.id
    );
    if (errorCount === 0 && warningCount === 0) {
      return "";
    }
    return ` ${errorCount > 0 ? "✕" : ""}${warningCount > 0 ? "⚠" : ""}`;
  }

  const ownerFlatTree = state !== null ? state.ownerFlatTree : null;
  if (ownerFlatTree !== null) {
    snapshotLines.push("[owners]" + (includeWeight ? ` (${ownerFlatTree.length})` : ""));
    ownerFlatTree.forEach((element, index) => {
      const printedSelectedMarker = printSelectedMarker(index);
      const printedElement = printElement(element, false);
      const printedErrorsAndWarnings = printErrorsAndWarnings(element);
      snapshotLines.push(
        `${printedSelectedMarker}${printedElement}${printedErrorsAndWarnings}`
      );
    });
  } else {
    const errorsAndWarnings = store._errorsAndWarnings;
    if (errorsAndWarnings.size > 0) {
      let errorCount = 0;
      let warningCount = 0;
      errorsAndWarnings.forEach(entry => {
        errorCount += entry.errorCount;
        warningCount += entry.warningCount;
      });

      snapshotLines.push(`✕ ${errorCount}, ⚠ ${warningCount}`);
    }

    store.roots.forEach(rootID => {
      const { weight } = store.getElementByID(rootID) as Element;
      const maybeWeightLabel = includeWeight ? ` (${weight})` : "";

      // Store does not (yet) expose a way to get errors/warnings per root.
      snapshotLines.push(`[root (${rootID})]${maybeWeightLabel}`);

      for (let i = rootWeight; i < rootWeight + weight; i++) {
        const element = store.getElementAtIndex(i);

        if (element == null) {
          throw Error(`Could not find element at index "${i}"`);
        }

        const printedSelectedMarker = printSelectedMarker(i);
        const printedElement = printElement(element, includeWeight);
        const printedErrorsAndWarnings = printErrorsAndWarnings(element);
        snapshotLines.push(
          `${printedSelectedMarker}${printedElement}${printedErrorsAndWarnings}`
        );
      }

      rootWeight += weight;
    });

    // Make sure the pretty-printed test align with the Store's reported number of total rows.
    if (rootWeight !== store.numElements) {
      throw Error(
        `Inconsistent Store state. Individual root weights ("${rootWeight}") do not match total weight ("${store.numElements}")`
      );
    }

    // If roots have been unmounted, verify that they've been removed from maps.
    // This helps ensure the Store doesn't leak memory.
    store.assertExpectedRootMapSizes();
  }

  return snapshotLines.join("\n");
}

// We use JSON.parse to parse string values
// e.g. 'foo' is not valid JSON but it is a valid string
// so this method replaces e.g. 'foo' with "foo"
export function sanitizeForParse(value: any): any | string {
  if (typeof value === "string") {
    if (
      value.length >= 2 &&
      value.charAt(0) === "'" &&
      value.charAt(value.length - 1) === "'"
    ) {
      return '"' + value.slice(1, value.length - 1) + '"';
    }
  }
  return value;
}

export function smartParse(value: any): any | void | number {
  switch (value) {
    case "Infinity":
      return Infinity;
    case "NaN":
      return NaN;
    case "undefined":
      return undefined;
    default:
      return JSON.parse(sanitizeForParse(value));
  }
}

export function smartStringify(value: any): string {
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      return "NaN";
    } else if (!Number.isFinite(value)) {
      return "Infinity";
    }
  } else if (value === undefined) {
    return "undefined";
  }

  return JSON.stringify(value);
}

type StateContext = {
  // Tree
  numElements: number;
  ownerSubtreeLeafElementID: number | null;
  selectedElementID: number | null;
  selectedElementIndex: number | null;

  // Search
  searchIndex: number | null;
  searchResults: Array<number>;
  searchText: string;

  // Owners
  ownerID: number | null;
  ownerFlatTree: Array<Element> | null;

  // Inspection element panel
  inspectedElementID: number | null;
};

export type Wall = {
  // `listen` returns the "unlisten" function.
  listen: (fn: () => void) => () => void;
  send: (event: string, payload: any, transferable?: Array<any>) => void;
};

// Each element on the frontend corresponds to a Fiber on the backend.
// Some of its information (e.g. id, type, displayName) come from the backend.
// Other bits (e.g. weight and depth) are computed on the frontend for windowing and display purposes.
// Elements are updated on a push basis– meaning the backend pushes updates to the frontend when needed.
export type Element = {
  id: number;
  parentID: number;
  children: Array<number>;
  type: ElementType;
  displayName: string | null;
  key: number | string | null;

  hocDisplayNames: null | Array<string>;

  // Should the elements children be visible in the tree?
  isCollapsed: boolean;

  // Owner (if available)
  ownerID: number;

  // How many levels deep within the tree is this element?
  // This determines how much indentation (left padding) should be used in the Elements tree.
  depth: number;

  // How many nodes (including itself) are below this Element within the tree.
  // This property is used to quickly determine the total number of Elements,
  // and the Element at any given index (for windowing purposes).
  weight: number;

  // This element is not in a StrictMode compliant subtree.
  // Only true for React versions supporting StrictMode.
  isStrictModeNonCompliant: boolean;
};

export type SerializedElement = {
  displayName: string | null;
  id: number;
  key: number | string | null;
  hocDisplayNames: Array<string> | null;
  type: ElementType;
};

export type OwnersList = {
  id: number;
  owners: Array<SerializedElement> | null;
};

export type InspectedElementResponseType =
  | "error"
  | "full-data"
  | "hydrated-path"
  | "no-change"
  | "not-found";

export type InspectedElement = {
  id: number;

  // Does the current renderer support editable hooks and function props?
  canEditHooks: boolean;
  canEditFunctionProps: boolean;

  // Does the current renderer support advanced editing interface?
  canEditHooksAndDeletePaths: boolean;
  canEditHooksAndRenamePaths: boolean;
  canEditFunctionPropsDeletePaths: boolean;
  canEditFunctionPropsRenamePaths: boolean;

  // Is this Error, and can its value be overridden now?
  isErrored: boolean;
  canToggleError: boolean;
  targetErrorBoundaryID?: number;

  // Is this Suspense, and can its value be overridden now?
  canToggleSuspense: boolean;

  // Can view component source location.
  canViewSource: boolean;

  // Does the component have legacy context attached to it.
  hasLegacyContext: boolean;

  // Inspectable properties.
  context: Record<string, unknown> | null;
  hooks: Record<string, unknown> | null;
  props: Record<string, unknown> | null;
  state: Record<string, unknown> | null;
  key: number | string | null;
  errors: Array<[string, number]>;
  warnings: Array<[string, number]>;

  // List of owners
  owners: Array<SerializedElement> | null;

  // Location of component in source code.
  source: any | null;

  type: ElementType;

  // Meta information about the root this element belongs to.
  rootType: string | null;

  // Meta information about the renderer that created this element.
  rendererPackageName: string | null;
  rendererVersion: string | null;

  // UI plugins/visualizations for the inspected element.
  // plugins: Plugins;
};

const __DEV__ = true;

type ErrorAndWarningTuples = Array<{
  id: number;
  index: number;
}>;

export type Capabilities = {
  supportsBasicProfiling: boolean;
  hasOwnerMetadata: boolean;
  supportsStrictMode: boolean;
  supportsTimeline: boolean;
};

/**
 * The store is the single source of truth for updates from the backend.
 * ContextProviders can subscribe to the Store for specific things they want to provide.
 */

export class Store {
  // If the backend version is new enough to report its (NPM) version, this is it.
  // This version may be displayed by the frontend for debugging purposes.
  _backendVersion: string | null = null;
  // Computed whenever _errorsAndWarnings Map changes.
  _cachedErrorCount: number = 0;
  _cachedWarningCount: number = 0;
  _cachedErrorAndWarningTuples: ErrorAndWarningTuples | null = null;
  // Should new nodes be collapsed by default when added to the tree?
  _collapseNodesByDefault: boolean = true;
  // Map of ID to number of recorded error and warning message IDs.
  _errorsAndWarnings: Map<
    number,
    {
      errorCount: number;
      warningCount: number;
    }
  > = new Map();
  // At least one of the injected renderers contains (DEV only) owner metadata.
  _hasOwnerMetadata: boolean = false;
  // Map of ID to (mutable) Element.
  // Elements are mutated to avoid excessive cloning during tree updates.
  // The InspectedElement Suspense cache also relies on this mutability for its WeakMap usage.
  _idToElement: Map<number, Element> = new Map();
  // Should the React Native style editor panel be shown?
  _isNativeStyleEditorSupported: boolean = false;
  // Can the backend use the Storage API (e.g. localStorage)?
  // If not, features like reload-and-profile will not work correctly and must be disabled.
  _isBackendStorageAPISupported: boolean = false;
  // Can DevTools use sync XHR requests?
  // If not, features like reload-and-profile will not work correctly and must be disabled.
  // This current limitation applies only to web extension builds
  // and will need to be reconsidered in the future if we add support for reload to React Native.
  _isSynchronousXHRSupported: boolean = false;
  _nativeStyleEditorValidAttributes: ReadonlyArray<string> | null = null;
  // Older backends don't support an explicit bridge protocol,
  // so we should timeout eventually and show a downgrade message.
  _onBridgeProtocolTimeoutID: NodeJS.Timeout | null = null;
  // Map of element (id) to the set of elements (ids) it owns.
  // This map enables getOwnersListForElement() to avoid traversing the entire tree.
  _ownersMap: Map<number, Set<number>> = new Map();
  // _profilerStore: ProfilerStore;
  _recordChangeDescriptions: boolean = false;
  // Incremented each time the store is mutated.
  // This enables a passive effect to detect a mutation between render and commit phase.
  _revision: number = 0;
  // This Array must be treated as immutable!
  // Passive effects will check it for changes between render and mount.
  _roots: ReadonlyArray<number> = [];
  _rootIDToCapabilities: Map<number, Capabilities> = new Map();
  // Renderer ID is needed to support inspection fiber props, state, and hooks.
  _rootIDToRendererID: Map<number, number> = new Map();
  // These options may be initially set by a confiugraiton option when constructing the Store.
  _supportsNativeInspection: boolean = true;
  _supportsProfiling: boolean = false;
  _supportsReloadAndProfile: boolean = false;
  _supportsTimeline: boolean = false;
  _supportsTraceUpdates: boolean = false;
  // These options default to false but may be updated as roots are added and removed.
  _rootSupportsBasicProfiling: boolean = false;
  _rootSupportsTimelineProfiling: boolean = false;
  // _bridgeProtocol: BridgeProtocol | null = null;
  _bridgeProtocol: {
    version: 2;
  } = { version: 2 };
  _unsupportedBridgeProtocolDetected: boolean = false;
  _unsupportedRendererVersionDetected: boolean = false;
  // Total number of visible elements (within all roots).
  // Used for windowing purposes.
  _weightAcrossRoots: number = 0;

  constructor() {
    this._collapseNodesByDefault = false;
    this._recordChangeDescriptions = false;
  }

  // This is only used in tests to avoid memory leaks.
  assertExpectedRootMapSizes() {
    if (this.roots.length === 0) {
      // The only safe time to assert these maps are empty is when the store is empty.
      this.assertMapSizeMatchesRootCount(this._idToElement, "_idToElement");
      this.assertMapSizeMatchesRootCount(this._ownersMap, "_ownersMap");
    }

    // These maps should always be the same size as the number of roots
    this.assertMapSizeMatchesRootCount(
      this._rootIDToCapabilities,
      "_rootIDToCapabilities"
    );
    this.assertMapSizeMatchesRootCount(this._rootIDToRendererID, "_rootIDToRendererID");
  }

  // This is only used in tests to avoid memory leaks.
  assertMapSizeMatchesRootCount(map: Map<any, any>, mapName: string) {
    const expectedSize = this.roots.length;

    if (map.size !== expectedSize) {
      this._throwAndEmitError(
        Error(
          `Expected ${mapName} to contain ${expectedSize} items, but it contains ${
            map.size
          } items\n\n${inspect(map, {
            depth: 20,
          })}`
        )
      );
    }
  }

  get backendVersion(): string | null {
    return this._backendVersion;
  }

  get collapseNodesByDefault(): boolean {
    return this._collapseNodesByDefault;
  }

  set collapseNodesByDefault(value: boolean) {
    this._collapseNodesByDefault = value;
  }

  get errorCount(): number {
    return this._cachedErrorCount;
  }

  get hasOwnerMetadata(): boolean {
    return this._hasOwnerMetadata;
  }

  get nativeStyleEditorValidAttributes(): ReadonlyArray<string> | null {
    return this._nativeStyleEditorValidAttributes;
  }

  get numElements(): number {
    return this._weightAcrossRoots;
  }

  get recordChangeDescriptions(): boolean {
    return this._recordChangeDescriptions;
  }

  set recordChangeDescriptions(value: boolean) {
    this._recordChangeDescriptions = value;
  }

  get revision(): number {
    return this._revision;
  }

  get rootIDToRendererID(): Map<number, number> {
    return this._rootIDToRendererID;
  }

  get roots(): ReadonlyArray<number> {
    return this._roots;
  }

  // At least one of the currently mounted roots support the Legacy profiler.
  get rootSupportsBasicProfiling(): boolean {
    return this._rootSupportsBasicProfiling;
  }

  // At least one of the currently mounted roots support the Timeline profiler.
  get rootSupportsTimelineProfiling(): boolean {
    return this._rootSupportsTimelineProfiling;
  }

  get supportsNativeInspection(): boolean {
    return this._supportsNativeInspection;
  }

  get supportsNativeStyleEditor(): boolean {
    return this._isNativeStyleEditorSupported;
  }

  // This build of DevTools supports the legacy profiler.
  // This is a static flag, controled by the Store config.
  get supportsProfiling(): boolean {
    return this._supportsProfiling;
  }

  get supportsReloadAndProfile(): boolean {
    // Does the DevTools shell support reloading and eagerly injecting the renderer interface?
    // And if so, can the backend use the localStorage API and sync XHR?
    // All of these are currently required for the reload-and-profile feature to work.
    return (
      this._supportsReloadAndProfile &&
      this._isBackendStorageAPISupported &&
      this._isSynchronousXHRSupported
    );
  }

  // This build of DevTools supports the Timeline profiler.
  // This is a static flag, controled by the Store config.
  get supportsTimeline(): boolean {
    return this._supportsTimeline;
  }

  get supportsTraceUpdates(): boolean {
    return this._supportsTraceUpdates;
  }

  get unsupportedBridgeProtocolDetected(): boolean {
    return this._unsupportedBridgeProtocolDetected;
  }

  get unsupportedRendererVersionDetected(): boolean {
    return this._unsupportedRendererVersionDetected;
  }

  get warningCount(): number {
    return this._cachedWarningCount;
  }

  containsElement(id: number): boolean {
    return this._idToElement.get(id) != null;
  }

  getElementAtIndex(index: number): Element | null {
    if (index < 0 || index >= this.numElements) {
      console.warn(
        `Invalid index ${index} specified; store contains ${this.numElements} items.`
      );
      return null;
    }

    // Find which root this element is in...
    let rootID;
    let root;
    let rootWeight = 0;

    for (let i = 0; i < this._roots.length; i++) {
      rootID = this._roots[i];
      root = (this._idToElement.get(rootID) as any) as Element;

      if (root.children.length === 0) {
        continue;
      } else if (rootWeight + root.weight > index) {
        break;
      } else {
        rootWeight += root.weight;
      }
    }

    // Find the element in the tree using the weight of each node...
    // Skip over the root itself, because roots aren't visible in the Elements tree.
    let currentElement = (root as any) as Element;
    let currentWeight = rootWeight - 1;

    while (index !== currentWeight) {
      const numChildren = currentElement.children.length;

      for (let i = 0; i < numChildren; i++) {
        const childID = currentElement.children[i];
        const child = (this._idToElement.get(childID) as any) as Element;
        const childWeight = child.isCollapsed ? 1 : child.weight;

        if (index <= currentWeight + childWeight) {
          currentWeight++;
          currentElement = child;
          break;
        } else {
          currentWeight += childWeight;
        }
      }
    }

    return ((currentElement as any) as Element) || null;
  }

  getElementIDAtIndex(index: number): number | null {
    const element: Element | null = this.getElementAtIndex(index);
    return element === null ? null : element.id;
  }

  getElementByID(id: number): Element | null {
    const element = this._idToElement.get(id);

    if (element == null) {
      // console.warn(`No element found with id "${id}"`);
      return null;
    }

    return element;
  }

  // Returns a tuple of [id, index]
  getElementsWithErrorsAndWarnings(): Array<{
    id: number;
    index: number;
  }> {
    if (this._cachedErrorAndWarningTuples !== null) {
      return this._cachedErrorAndWarningTuples;
    } else {
      const errorAndWarningTuples: ErrorAndWarningTuples = [];

      this._errorsAndWarnings.forEach((_, id) => {
        const index = this.getIndexOfElementID(id);

        if (index !== null) {
          let low = 0;
          let high = errorAndWarningTuples.length;

          while (low < high) {
            const mid = (low + high) >> 1;

            if (errorAndWarningTuples[mid].index > index) {
              high = mid;
            } else {
              low = mid + 1;
            }
          }

          errorAndWarningTuples.splice(low, 0, {
            id,
            index,
          });
        }
      });

      // Cache for later (at least until the tree changes again).
      this._cachedErrorAndWarningTuples = errorAndWarningTuples;
      return errorAndWarningTuples;
    }
  }

  getErrorAndWarningCountForElementID(
    id: number
  ): {
    errorCount: number;
    warningCount: number;
  } {
    return (
      this._errorsAndWarnings.get(id) || {
        errorCount: 0,
        warningCount: 0,
      }
    );
  }

  getIndexOfElementID(id: number): number | null {
    const element = this.getElementByID(id);

    if (element === null || element.parentID === 0) {
      return null;
    }

    // Walk up the tree to the root.
    // Increment the index by one for each node we encounter,
    // and by the weight of all nodes to the left of the current one.
    // This should be a relatively fast way of determining the index of a node within the tree.
    let previousID = id;
    let currentID = element.parentID;
    let index = 0;

    while (true) {
      const current = (this._idToElement.get(currentID) as any) as Element;
      const { children } = current;

      for (let i = 0; i < children.length; i++) {
        const childID = children[i];

        if (childID === previousID) {
          break;
        }

        const child = (this._idToElement.get(childID) as any) as Element;
        index += child.isCollapsed ? 1 : child.weight;
      }

      if (current.parentID === 0) {
        // We found the root; stop crawling.
        break;
      }

      index++;
      previousID = current.id;
      currentID = current.parentID;
    }

    // At this point, the current ID is a root (from the previous loop).
    // We also need to offset the index by previous root weights.
    for (let i = 0; i < this._roots.length; i++) {
      const rootID = this._roots[i];

      if (rootID === currentID) {
        break;
      }

      const root = (this._idToElement.get(rootID) as any) as Element;
      index += root.weight;
    }

    return index;
  }

  getOwnersListForElement(ownerID: number): Array<Element> {
    const list: Array<Element> = [];

    const element = this._idToElement.get(ownerID);

    if (element != null) {
      list.push({ ...element, depth: 0 });

      const unsortedIDs = this._ownersMap.get(ownerID);

      if (unsortedIDs !== undefined) {
        const depthMap: Map<number, number> = new Map([[ownerID, 0]]);
        // Items in a set are ordered based on insertion.
        // This does not correlate with their order in the tree.
        // So first we need to order them.
        // I wish we could avoid this sorting operation; we could sort at insertion time,
        // but then we'd have to pay sorting costs even if the owners list was never used.
        // Seems better to defer the cost, since the set of ids is probably pretty small.
        const sortedIDs = Array.from(unsortedIDs).sort(
          (idA, idB) =>
            ((this.getIndexOfElementID(idA) as any) as number) -
            ((this.getIndexOfElementID(idB) as any) as number)
        );
        // Next we need to determine the appropriate depth for each element in the list.
        // The depth in the list may not correspond to the depth in the tree,
        // because the list has been filtered to remove intermediate components.
        // Perhaps the easiest way to do this is to walk up the tree until we reach either:
        // (1) another node that's already in the tree, or (2) the root (owner)
        // at which point, our depth is just the depth of that node plus one.
        sortedIDs.forEach(id => {
          const innerElement = this._idToElement.get(id);

          if (innerElement != null) {
            let parentID = innerElement.parentID;
            let depth = 0;

            while (parentID > 0) {
              if (parentID === ownerID || unsortedIDs.has(parentID)) {
                // $FlowFixMe[unsafe-addition] addition with possible null/undefined value
                depth = depthMap.get(parentID)! + 1;
                depthMap.set(id, depth);
                break;
              }

              const parent = this._idToElement.get(parentID);

              if (parent == null) {
                break;
              }

              parentID = parent.parentID;
            }

            if (depth === 0) {
              this._throwAndEmitError(Error("Invalid owners list"));
            }

            list.push({ ...innerElement, depth });
          }
        });
      }
    }

    return list;
  }

  getRendererIDForElement(id: number): number | null {
    let current = this._idToElement.get(id);

    while (current != null) {
      if (current.parentID === 0) {
        const rendererID = this._rootIDToRendererID.get(current.id);

        return rendererID == null ? null : rendererID;
      } else {
        current = this._idToElement.get(current.parentID);
      }
    }

    return null;
  }

  getRootIDForElement(id: number): number | null {
    let current = this._idToElement.get(id);

    while (current != null) {
      if (current.parentID === 0) {
        return current.id;
      } else {
        current = this._idToElement.get(current.parentID);
      }
    }

    return null;
  }

  isInsideCollapsedSubTree(id: number): boolean {
    let current = this._idToElement.get(id);

    while (current != null) {
      if (current.parentID === 0) {
        return false;
      } else {
        current = this._idToElement.get(current.parentID);

        if (current != null && current.isCollapsed) {
          return true;
        }
      }
    }

    return false;
  }

  // TODO Maybe split this into two methods: expand() and collapse()
  toggleIsCollapsed(id: number, isCollapsed: boolean): void {
    let didMutate = false;
    const element = this.getElementByID(id);

    if (element !== null) {
      if (isCollapsed) {
        if (element.type === ElementTypeRoot) {
          this._throwAndEmitError(Error("Root nodes cannot be collapsed"));
        }

        if (!element.isCollapsed) {
          didMutate = true;
          element.isCollapsed = true;
          const weightDelta = 1 - element.weight;
          let parentElement: void | Element = (this._idToElement.get(
            element.parentID
          ) as any) as Element;

          while (parentElement != null) {
            // We don't need to break on a collapsed parent in the same way as the expand case below.
            // That's because collapsing a node doesn't "bubble" and affect its parents.
            parentElement.weight += weightDelta;
            parentElement = this._idToElement.get(parentElement.parentID);
          }
        }
      } else {
        let currentElement: Element | null = element;

        while (currentElement != null) {
          const oldWeight = currentElement.isCollapsed ? 1 : currentElement.weight;

          if (currentElement.isCollapsed) {
            didMutate = true;
            currentElement.isCollapsed = false;
            const newWeight = currentElement.isCollapsed ? 1 : currentElement.weight;
            const weightDelta = newWeight - oldWeight;
            let parentElement: void | Element = (this._idToElement.get(
              currentElement.parentID
            ) as any) as Element;

            while (parentElement != null) {
              parentElement.weight += weightDelta;

              if (parentElement.isCollapsed) {
                // It's important to break on a collapsed parent when expanding nodes.
                // That's because expanding a node "bubbles" up and expands all parents as well.
                // Breaking in this case prevents us from over-incrementing the expanded weights.
                break;
              }

              parentElement = this._idToElement.get(parentElement.parentID);
            }
          }

          currentElement =
            currentElement.parentID !== 0 // $FlowFixMe[incompatible-type] found when upgrading Flow
              ? this.getElementByID(currentElement.parentID) // $FlowFixMe[incompatible-type] found when upgrading Flow
              : null;
        }
      }

      // Only re-calculate weights and emit an "update" event if the store was mutated.
      if (didMutate) {
        let weightAcrossRoots = 0;

        this._roots.forEach(rootID => {
          const { weight } = (this.getElementByID(rootID) as any) as Element;
          weightAcrossRoots += weight;
        });

        this._weightAcrossRoots = weightAcrossRoots;
        // The Tree context's search reducer expects an explicit list of ids for nodes that were added or removed.
        // In this  case, we can pass it empty arrays since nodes in a collapsed tree are still there (just hidden).
        // Updating the selected search index later may require auto-expanding a collapsed subtree though.
        // this.emit("mutated", [[], new Map()]);
      }
    }
  }

  _adjustParentTreeWeight: (
    parentElement: Element | null,
    weightDelta: number
  ) => void = (parentElement, weightDelta) => {
    let isInsideCollapsedSubTree = false;

    while (parentElement != null) {
      parentElement.weight += weightDelta;

      // Additions and deletions within a collapsed subtree should not bubble beyond the collapsed parent.
      // Their weight will bubble up when the parent is expanded.
      if (parentElement.isCollapsed) {
        isInsideCollapsedSubTree = true;
        break;
      }

      parentElement = (this._idToElement.get(parentElement.parentID) as any) as Element;
    }

    // Additions and deletions within a collapsed subtree should not affect the overall number of elements.
    if (!isInsideCollapsedSubTree) {
      this._weightAcrossRoots += weightDelta;
    }
  };

  _recursivelyUpdateSubtree(id: number, callback: (element: Element) => void): void {
    const element: Element | undefined = this._idToElement.get(id);

    if (element) {
      callback(element);
      (element as Element).children.forEach(child =>
        this._recursivelyUpdateSubtree(child, callback)
      );
    }
  }

  onBridgeNativeStyleEditorSupported: (arg0: {
    isSupported: boolean;
    validAttributes: ReadonlyArray<string> | null | undefined;
  }) => void = ({ isSupported, validAttributes }) => {
    this._isNativeStyleEditorSupported = isSupported;
    this._nativeStyleEditorValidAttributes = validAttributes || null;
    // this.emit("supportsNativeStyleEditor");
  };
  onBridgeOperations: (operations: Array<number>) => void = operations => {
    let haveRootsChanged = false;
    let haveErrorsOrWarningsChanged = false;
    // The first two values are always rendererID and rootID
    const rendererID = operations[0];
    const addedElementIDs: Array<number> = [];
    // This is a mapping of removed ID -> parent ID:
    const removedElementIDs: Map<number, number> = new Map();
    // We'll use the parent ID to adjust selection if it gets deleted.
    let i = 2;
    // Reassemble the string table.
    const stringTable: Array<string | null> = [
      null, // ID = 0 corresponds to the null string.
    ];
    const stringTableSize = operations[i++];
    const stringTableEnd = i + stringTableSize;

    while (i < stringTableEnd) {
      const nextLength = operations[i++];
      const nextString = utfDecodeString(operations.slice(i, i + nextLength) as any);
      stringTable.push(nextString);
      i += nextLength;
    }

    while (i < operations.length) {
      const operation = operations[i];

      switch (operation) {
        case TREE_OPERATION_ADD: {
          const id = (operations[i + 1] as any) as number;
          const type = (operations[i + 2] as any) as ElementType;
          i += 3;

          if (this._idToElement.has(id)) {
            this._throwAndEmitError(
              Error(
                `Cannot add node "${id}" because a node with that id is already in the Store.`
              )
            );
          }

          let ownerID = 0;
          let parentID: number = (null as any) as number;

          if (type === ElementTypeRoot) {
            const isStrictModeCompliant = operations[i] > 0;
            i++;
            const supportsBasicProfiling =
              (operations[i] & PROFILING_FLAG_BASIC_SUPPORT) !== 0;
            const supportsTimeline =
              (operations[i] & PROFILING_FLAG_TIMELINE_SUPPORT) !== 0;
            i++;
            let supportsStrictMode = false;
            let hasOwnerMetadata = false;

            // If we don't know the bridge protocol, guess that we're dealing with the latest.
            // If we do know it, we can take it into consideration when parsing operations.
            if (this._bridgeProtocol === null || this._bridgeProtocol.version >= 2) {
              supportsStrictMode = operations[i] > 0;
              i++;

              hasOwnerMetadata = operations[i] > 0;
              i++;
            }

            this._roots = this._roots.concat(id);

            this._rootIDToRendererID.set(id, rendererID);

            this._rootIDToCapabilities.set(id, {
              supportsBasicProfiling,
              hasOwnerMetadata,
              supportsStrictMode,
              supportsTimeline,
            });

            // Not all roots support StrictMode;
            // don't flag a root as non-compliant unless it also supports StrictMode.
            const isStrictModeNonCompliant = !isStrictModeCompliant && supportsStrictMode;

            this._idToElement.set(id, {
              children: [],
              depth: -1,
              displayName: null,
              hocDisplayNames: null,
              id,
              isCollapsed: false,
              // Never collapse roots; it would hide the entire tree.
              isStrictModeNonCompliant,
              key: null,
              ownerID: 0,
              parentID: 0,
              type,
              weight: 0,
            });

            haveRootsChanged = true;
          } else {
            parentID = (operations[i] as any) as number;
            i++;
            ownerID = (operations[i] as any) as number;
            i++;
            const displayNameStringID = operations[i];
            const displayName = stringTable[displayNameStringID];
            i++;
            const keyStringID = operations[i];
            const key = stringTable[keyStringID];
            i++;

            if (!this._idToElement.has(parentID)) {
              this._throwAndEmitError(
                Error(
                  `Cannot add child "${id}" to parent "${parentID}" because parent node was not found in the Store.`
                )
              );
            }

            const parentElement = (this._idToElement.get(parentID) as any) as Element;
            parentElement.children.push(id);

            const element: Element = {
              children: [],
              depth: parentElement.depth + 1,
              displayName,
              hocDisplayNames: null,
              id,
              isCollapsed: this._collapseNodesByDefault,
              isStrictModeNonCompliant: parentElement.isStrictModeNonCompliant,
              key,
              ownerID,
              parentID,
              type,
              weight: 1,
            };

            this._idToElement.set(id, element);

            addedElementIDs.push(id);

            this._adjustParentTreeWeight(parentElement, 1);

            if (ownerID > 0) {
              let set = this._ownersMap.get(ownerID);

              if (set === undefined) {
                set = new Set();

                this._ownersMap.set(ownerID, set);
              }

              set.add(id);
            }
          }

          break;
        }

        case TREE_OPERATION_REMOVE: {
          const removeLength = (operations[i + 1] as any) as number;
          i += 2;

          for (let removeIndex = 0; removeIndex < removeLength; removeIndex++) {
            const id = (operations[i] as any) as number;

            if (!this._idToElement.has(id)) {
              this._throwAndEmitError(
                Error(
                  `Cannot remove node "${id}" because no matching node was found in the Store.`
                )
              );
            }

            i += 1;
            const element = (this._idToElement.get(id) as any) as Element;
            const { children, ownerID, parentID, weight } = element;

            if (children.length > 0) {
              this._throwAndEmitError(
                Error(`Node "${id}" was removed before its children.`)
              );
            }

            this._idToElement.delete(id);

            let parentElement = null;

            if (parentID === 0) {
              this._roots = this._roots.filter(rootID => rootID !== id);

              this._rootIDToRendererID.delete(id);

              this._rootIDToCapabilities.delete(id);

              haveRootsChanged = true;
            } else {
              parentElement = (this._idToElement.get(parentID) as any) as Element;

              if (parentElement === undefined) {
                this._throwAndEmitError(
                  Error(
                    `Cannot remove node "${id}" from parent "${parentID}" because no matching node was found in the Store.`
                  )
                );
              }

              const index = parentElement.children.indexOf(id);
              parentElement.children.splice(index, 1);
            }

            this._adjustParentTreeWeight(parentElement, -weight);

            removedElementIDs.set(id, parentID);

            this._ownersMap.delete(id);

            if (ownerID > 0) {
              const set = this._ownersMap.get(ownerID);

              if (set !== undefined) {
                set.delete(id);
              }
            }

            if (this._errorsAndWarnings.has(id)) {
              this._errorsAndWarnings.delete(id);

              haveErrorsOrWarningsChanged = true;
            }
          }

          break;
        }

        case TREE_OPERATION_REMOVE_ROOT: {
          i += 1;
          const id = operations[1];

          const recursivelyDeleteElements = (elementID: number) => {
            const element = this._idToElement.get(elementID);

            this._idToElement.delete(elementID);

            if (element) {
              // Mostly for Flow's sake
              for (let index = 0; index < element.children.length; index++) {
                recursivelyDeleteElements(element.children[index]);
              }
            }
          };

          const root = (this._idToElement.get(id) as any) as Element;
          recursivelyDeleteElements(id);

          this._rootIDToCapabilities.delete(id);

          this._rootIDToRendererID.delete(id);

          this._roots = this._roots.filter(rootID => rootID !== id);
          this._weightAcrossRoots -= root.weight;
          break;
        }

        case TREE_OPERATION_REORDER_CHILDREN: {
          const id = (operations[i + 1] as any) as number;
          const numChildren = (operations[i + 2] as any) as number;
          i += 3;

          if (!this._idToElement.has(id)) {
            this._throwAndEmitError(
              Error(
                `Cannot reorder children for node "${id}" because no matching node was found in the Store.`
              )
            );
          }

          const element = (this._idToElement.get(id) as any) as Element;
          const children = element.children;

          const nextChildren: number[] = [];

          for (let j = 0; j < numChildren; j++) {
            const childID = operations[i + j];
            nextChildren[j] = childID;
          }

          if (children.length !== numChildren) {
            this._throwAndEmitError(
              Error(
                `Children cannot be added or removed during a reorder operation (current: ${children
                  .slice()
                  .sort()}, next: ${nextChildren.slice().sort()})})`
              )
            );
          }

          for (let j = 0; j < numChildren; j++) {
            const childID = nextChildren[j];
            children[j] = childID;

            if (__DEV__) {
              // This check is more expensive so it's gated by __DEV__.
              const childElement = this._idToElement.get(childID);

              if (childElement == null || childElement.parentID !== id) {
                console.error(
                  `Children cannot be added or removed during a reorder operation (current: ${children
                    .slice()
                    .sort()}, next: ${nextChildren.slice().sort()})})`
                );
              }
            }
          }

          i += numChildren;

          break;
        }

        case TREE_OPERATION_SET_SUBTREE_MODE: {
          const id = operations[i + 1];
          const mode = operations[i + 2];
          i += 3;

          // If elements have already been mounted in this subtree, update them.
          // (In practice, this likely only applies to the root element.)
          if (mode === StrictMode) {
            this._recursivelyUpdateSubtree(id, element => {
              element.isStrictModeNonCompliant = false;
            });
          }

          break;
        }

        case TREE_OPERATION_UPDATE_TREE_BASE_DURATION:
          // Base duration updates are only sent while profiling is in progress.
          // We can ignore them at this point.
          // The profiler UI uses them lazily in order to generate the tree.
          i += 3;
          break;

        case TREE_OPERATION_UPDATE_ERRORS_OR_WARNINGS: {
          const id = operations[i + 1];
          const errorCount = operations[i + 2];
          const warningCount = operations[i + 3];
          i += 4;

          if (errorCount > 0 || warningCount > 0) {
            this._errorsAndWarnings.set(id, {
              errorCount,
              warningCount,
            });
          } else if (this._errorsAndWarnings.has(id)) {
            this._errorsAndWarnings.delete(id);
          }

          haveErrorsOrWarningsChanged = true;
          break;
        }
        default:
          this._throwAndEmitError(
            new UnsupportedBridgeOperationError(
              `Unsupported Bridge operation "${operation}"`
            )
          );
      }
    }

    this._revision++;
    // Any time the tree changes (e.g. elements added, removed, or reordered) cached inidices may be invalid.
    this._cachedErrorAndWarningTuples = null;

    if (haveErrorsOrWarningsChanged) {
      let errorCount = 0;
      let warningCount = 0;

      this._errorsAndWarnings.forEach(entry => {
        errorCount += entry.errorCount;
        warningCount += entry.warningCount;
      });

      this._cachedErrorCount = errorCount;
      this._cachedWarningCount = warningCount;
    }

    if (haveRootsChanged) {
      this._hasOwnerMetadata = false;
      this._rootSupportsBasicProfiling = false;
      this._rootSupportsTimelineProfiling = false;

      this._rootIDToCapabilities.forEach(
        ({ supportsBasicProfiling, hasOwnerMetadata, supportsTimeline }) => {
          if (supportsBasicProfiling) {
            this._rootSupportsBasicProfiling = true;
          }

          if (hasOwnerMetadata) {
            this._hasOwnerMetadata = true;
          }

          if (supportsTimeline) {
            this._rootSupportsTimelineProfiling = true;
          }
        }
      );
    }
  };

  // The Store should never throw an Error without also emitting an event.
  // Otherwise Store errors will be invisible to users,
  // but the downstream errors they cause will be reported as bugs.
  // For example, https://github.com/facebook/react/issues/21402
  // Emitting an error event allows the ErrorBoundary to show the original error.
  _throwAndEmitError(error: Error): never {
    // Throwing is still valuable for local development
    // and for unit testing the Store itself.
    throw error;
  }
}
