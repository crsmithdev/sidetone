# A private Android app, side-loaded, because a page loses the microphone

A web page cannot hold the microphone open when the screen is locked, so the web
client only works with the screen on. The Android app exists for that one
reason: a foreground service of type microphone keeps the conversation while the
screen is off. It is installed by side-load and never published, so there is no
developer account, no store review and no release signing.

## Consequences

Updates are manual. The app is the same client as the page — the same room, the
same pairing, the same messages — so the bridge does not change for it.
