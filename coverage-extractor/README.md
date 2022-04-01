# Replay Protocol - Code Coverage Generation

This example demonstrates how to use the Replay Protocol to fetch a list of source entries, then retrieve the actual source file contents and the number of times each line in that source file was executed during the recording.

From there, it uses the [Istanbul code coverage library APIs](https://istanbul.js.org/) to generate an HTML format code coverage report for one of the source files.

This showcases one potential use case for Replay's "heat map" functionality outside of the Replay app UI.
