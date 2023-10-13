# Replay Processing Routines

This folder contains a copy-paste of the Replay backend processing "routines" as of 2023-10-13.

The code **will not compile or run as-is**. It was extracted directly from our internal backend repo, and still has imports from other backend files. Additionally, the routines code was designed to run as part of our backend server, so the scaffolding that loads and runs these routines does not exist here.

_However_: the actual logic and usage of the Replay Protocol API is entirely valid, and ought to work if it were copy-pasted from the routine setup into a standalone Node script. At time of writing I haven't done that - my immediate goal is to make this logic public so I can point to it during my upcoming React Advanced presentation on how we built our React DevTools support.

Overall, this is meant to be an example of the kinds of advanced analysis features you can build with Replay's powerful time-travel debugging API.

## Structure

This folder contains the current 3 routines, plus shared logic and scaffolding.

### Routines

- `reactDevTools`: generates React DevTools operations arrays for a recording
- `reactEventListeners`: generates "Jump to Code" entries for clicks and keyboard events in a recording, focusing on React props callbacks that may have run in response to an event
- `reduxDevTools`: extracts Redux action types from a recording

### Shared Logic

The `shared` folder contains logic we've built up over time to work with our protocol effectively:

- Data caches for core protocol types (objects, frames, scopes, pauses, sources)
- The `ReplayClient` wrapper that wraps calls to the protocol and simplifies session handling and API call results
- Utilities for time-related values such as protocol execution points
- Assorted other utilities

## More Info

- [Replay Blog: How We Rebuilt React DevTools with Replay Routines](https://blog.replay.io/how-we-rebuilt-react-devtools-with-replay-routines) (Jan 2023)
- Upcoming: Mark's talk "Building Better React Debugging with Replay Analysis" at React Advanced 2023 ( https://reactadvanced.com/#speakers )
- Contact Mark! [https://twitter.com/acemarke](https://twitter.com/acemarke), or [`@acemarke` in the Replay Discord](https://discord.gg/replayio)
