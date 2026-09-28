package dev.crsmith.sidetone

import kotlinx.coroutines.flow.Flow

/**
 * What the client needs from the room: send a data message, publish and
 * unpublish the microphone track, and hear what happens in the room. The app
 * hands in [LiveKitRoom]; a test hands in one that writes down what it was sent.
 */
interface Room {
    /** What happened in the room, in the words of the client. */
    sealed interface Event {
        /** The transport lost the room and is getting it back by itself. */
        data object Reconnecting : Event

        /** The transport has the room back. */
        data object Reconnected : Event

        /** The room ended, for the reason the transport gave. */
        data class Ended(val reason: String) : Event

        /** 17.11.11 a bridge came into the room. */
        data object BridgeArrived : Event

        /** 17.11.11 a bridge left the room. `last` says no other bridge stays in it. */
        data class BridgeLeft(val last: Boolean) : Event

        /** N.1.4 the phone's own uplink changed, as a word. */
        data class Quality(val quality: String) : Event

        /** Item 56 the bridge started or stopped speaking, as LiveKit's active speakers say. */
        data class BridgeSpeaking(val on: Boolean) : Event

        /** A data message from the bridge. */
        class Data(val payload: ByteArray) : Event
    }

    val events: Flow<Event>

    /** Send one data message to the bridge. */
    suspend fun send(payload: ByteArray): Result<Unit>

    /** Item 56 what the phone has received of the bridge's audio so far, or null before any arrives. */
    suspend fun received(): Received?

    /** Publish a new microphone track. It throws when the track does not publish. */
    suspend fun openMic()

    /** 17.10 unpublish the microphone track and dispose it, so the device is released (ADR 0008). */
    fun closeMic()
}
