# LiveKit over WebRTC for the room

The audio path has to keep the microphone open while the bridge speaks, cancel
the echo that causes, survive a connection that drops and hands between towers
in a car, and work the same in a browser and in a native app. WebRTC is built
for that and LiveKit is the proven framework over it, so the transport is not
hand-built and the echo cancellation is the framework's, at the client.

## Considered options

- **Plain websockets.** Every hard part — echo cancellation, barge-in while
  playing, recovery on a moving network — becomes ours.
- **A telephone call.** The earlier plan, chosen because a web page on iOS
  cannot hold the microphone behind a lock screen. Dropped once screen-on voice
  was accepted for the web client: the call adds cost and a cloud hop and buys
  nothing else. See [0007](0007-a-private-android-app.md).

## Consequences

Both clients get echo cancellation from the framework rather than from us, and
a change of client does not change the bridge.
