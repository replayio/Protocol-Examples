# Replay Protocol API Examples

This repo contains examples that demonstrate how you can write your own programs that use the Replay Protocol API to interact with recordings.

The Replay Protocol is documented here, including initial connection details and API methods:

**https://static.replay.io/protocol/**

## Protocol Auth

We don't yet have an example that actually authenticates to the API.

The WebSocket connection can currently be established without needing to authenticate.

If the recording is public, then you can create a session anonymously.  Otherwise, you'll get an auth error when creating the session if you haven't set a token first.  Auth is also required for all methods that create recordings.

The protocol provides an [`Authentication.setAccessToken` method](https://static.replay.io/protocol/tot/Authentication/#method-setAccessToken).  The token should be an API key (which can be generated in your Replay user settings panel).  

## Available Examples

### Code Coverage Extraction

Collects a list of source files from a recording, downloads a source file's contents, requests line hit counts for that file, and writes out an HTML format code coverage report to show how much of the file was executed during the recording.