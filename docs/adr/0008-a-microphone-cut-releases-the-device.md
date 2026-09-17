# A microphone cut releases the device rather than muting the track

When Chris cuts the microphone, the client stops the recording device instead of
muting a stream that keeps running. A muted track leaves the phone's own
recording indicator lit, which asks him to trust a button over his own phone. The
client also tells the bridge, so anything half recorded is dropped rather than
arriving as a fragment when the microphone comes back.

## Consequences

Each client does this its own way — the web client unpublishes the track on
mute, the app publishes a track of its own and disposes it — and a regression
shows up only as an indicator that stays on.
