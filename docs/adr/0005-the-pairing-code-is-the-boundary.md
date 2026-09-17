# The pairing code is the boundary, not the tailnet

The bridge listens on a port that the tailnet can reach, and a tailnet is a good
boundary, but it is not the boundary: anything that can reach the port can hear
the conversation and drive the agent. A client pairs once against a three-word
code the bridge prints, then keeps a long-lived token, and the same method
serves both clients. The code is spoken aloud, so it stays three words and a
wrong one costs an increasing delay instead of nothing.

## Consequences

The code also appears as a QR code, with the code in the fragment of the link,
so a client that opens the link as a web page never sends the code to a server
or into a log. `/diagnostics` carries the transcript and is served to loopback
only.
