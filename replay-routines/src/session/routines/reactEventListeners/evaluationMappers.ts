/* Copyright 2023 Record Replay Inc. */

// Implementations of `runEvaluation` expressions to be evaluated
// in the remote browser as part of the React Event Listeners routine`

import {
  InteractionEventKind,
  REACT_EVENT_PROPS,
  EVENT_CLASS_FOR_EVENT_TYPE,
  REACT_16_EVENT_LISTENER_PROP_KEY,
  REACT_17_18_EVENT_LISTENER_PROP_KEY,
} from "./constants";

type UnknownFunction = (...args: unknown[]) => unknown;

// Local variables in scope at the time of evaluation
declare let event: MouseEvent | KeyboardEvent;

interface InjectedValues {
  eventType: InteractionEventKind;
  $REACT_16_EVENT_LISTENER_PROP_KEY: string;
  $REACT_17_18_EVENT_LISTENER_PROP_KEY: string;
  EVENT_CLASS_NAMES: string[];
  possibleReactPropNames: string[];
  args: unknown[];
}

interface EventMapperSuccessResult {
  handlerProp: UnknownFunction;
  fieldName?: string;
}
interface EventMapperFailureResult {
  handlerProp?: undefined;
}
type EventMapperResult = EventMapperSuccessResult | EventMapperFailureResult;

export function createReactEventMapper(eventType: InteractionEventKind) {
  const reactEventPropNames = REACT_EVENT_PROPS[eventType];
  const eventClassNames = EVENT_CLASS_FOR_EVENT_TYPE[eventType];

  // This function will be evaluated as a JS expression in the paused browser
  function findEventTargetAndHandler(injectedValues: InjectedValues) {
    // One of the args should be a browser event. There could be multiple event class types we're looking for,
    // such as `MouseEvent` or `InputEvent`, so loop over the args _and_ the class names.
    const eventArgs = injectedValues.args.filter(
      a => typeof a === "object" && a instanceof Event
    );
    const matchingEvent = eventArgs.find(a => {
      const matchesEventType = injectedValues.EVENT_CLASS_NAMES.some(eventClassName => {
        const eventClass: any = window[eventClassName as any];
        return a instanceof eventClass;
      });
      return matchesEventType;
    });

    if (!matchingEvent) {
      return "NO_EVENT_FOUND";
    }

    let res: EventMapperResult = {};

    // Search the event target node and all of its ancestors
    // for React internal props data, and specifically look
    // for the nearest node with a relevant React event handler prop if any.
    let clickWasInsideSubmitButton = false;
    const startingNode = event.target as HTMLElement;
    let currentNode = startingNode;
    while (currentNode) {
      const currentNodeName = currentNode.nodeName.toLowerCase();

      if (
        injectedValues.eventType === "mousedown" &&
        currentNodeName === "button" &&
        (currentNode as HTMLButtonElement).type === "submit"
      ) {
        clickWasInsideSubmitButton = true;
      }

      const keys = Object.keys(currentNode);
      const reactPropsKey = keys.find(key => {
        return (
          key.startsWith(injectedValues.$REACT_16_EVENT_LISTENER_PROP_KEY) ||
          key.startsWith(injectedValues.$REACT_17_18_EVENT_LISTENER_PROP_KEY)
        );
      });

      if (reactPropsKey) {
        let props: Record<string, UnknownFunction> = {};
        if (reactPropsKey in currentNode) {
          // @ts-expect-error - this is a dynamic key
          props = currentNode[reactPropsKey];
        }

        // Depending on the type of event, there could be different
        // React event handler prop names in use.
        // For example, an input is likely to have "onChange",
        // whereas some other element might have "onKeyPress".
        let handler = undefined;
        let name: string | undefined = undefined;
        const possibleReactPropNames = injectedValues.possibleReactPropNames.slice();

        // `<input>` tags often have an `onChange` prop, including checkboxes;
        // _If_ the original target DOM node is an input, add that to the list of prop names.
        if (currentNode === startingNode && currentNodeName === "input") {
          possibleReactPropNames.push("onChange");
        }

        if (clickWasInsideSubmitButton && currentNodeName === "form") {
          possibleReactPropNames.push("onSubmit");
        }

        for (const possibleReactProp of possibleReactPropNames) {
          if (possibleReactProp in props) {
            handler = props[possibleReactProp];
            name = possibleReactProp;
          }
        }

        if (handler) {
          res = {
            handlerProp: handler,
            fieldName: name,
          };
          break;
        }
      }
      currentNode = (currentNode!.parentNode as HTMLElement)!;
    }

    return res;
  }

  // Arrow functions don't have their own `arguments` object,
  // so safety-check to see if we can access it.
  // This does mean that we may not find a React prop target
  // for some listener entry points
  // TODO We could maybe use source outlines to get a list of argument names here.
  // But, that would require unique expressions per evaluated point.
  const evaluatedEventMapperBody = `
    if (typeof arguments !== "undefined") {
      (${findEventTargetAndHandler})({
        eventType: "${eventType}",
        $REACT_16_EVENT_LISTENER_PROP_KEY: "${REACT_16_EVENT_LISTENER_PROP_KEY}",
        $REACT_17_18_EVENT_LISTENER_PROP_KEY: "${REACT_17_18_EVENT_LISTENER_PROP_KEY}",
        EVENT_CLASS_NAMES: ${JSON.stringify(eventClassNames)},
        possibleReactPropNames: ${JSON.stringify(reactEventPropNames)},

        // Outer body runs in scope of the "current" event handler.
        // Grab the event handler's arguments.
        args: [...arguments]
      })
    }

  `;

  return evaluatedEventMapperBody;
}
